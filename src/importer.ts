/**
 * Import a ghost-activitypub-exporter backup of an ap.ghost.org account into
 * a self-hosted TryGhost/ActivityPub server, keeping the actor URL.
 *
 * This file is not run directly. bin/ghost-activitypub-importer.js bundles it against
 * the TryGhost/ActivityPub source at the revision the server runs, and runs
 * the bundle in a one-off container from the server's image, with the
 * server's environment, network and volumes. See README.md.
 *
 *   prepare  <exportDir> <signHost>
 *   mappings <exportDir> <ghostUrl> <contentApiKey>
 *   cutover  <exportDir> [--commit]
 *   media    <exportDir> [--commit]
 *   objects  <exportDir> [--commit]
 *
 * prepare  Additive only. Fetches the account itself and every remote
 *          account and post the export refers to that the DB does not have
 *          yet, through the server's own ensureByApId / getByApId. Run it
 *          while the old server still hosts the actor. Writes
 *          <exportDir>/handles.json (handle -> ap_id).
 * mappings Reads the Ghost site's UUID and posts from the new Ghost site and
 *          matches the account's articles to its posts by slug. Writes
 *          <exportDir>/mappings.json. No DB access.
 * cutover  One transaction. Makes the existing remote account the internal
 *          account of a site row for its host, then restores follows, likes,
 *          reposts, outbox, feed, notifications, Ghost post mappings, stored
 *          objects and the Bluesky handle. Without --commit it rolls back
 *          after printing what it would do. Idempotent.
 * media    Copies the exported ap.ghost.org bucket images into the server's
 *          local storage (LOCAL_STORAGE_PATH) and rewrites the account's
 *          posts and stored objects to the new URLs. Without --commit it only
 *          reports.
 * objects  Stores Note and Create objects for the account's notes that have
 *          a posts row but no stored object (posts the export did not
 *          contain), so their URLs resolve and can be liked and replied to.
 *          Without --commit it only reports.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import {
    exportJwk,
    generateCryptoKeyPair,
    getAuthenticatedDocumentLoader,
    importJwk,
} from '@fedify/fedify';
import { lookupWebFinger } from '@fedify/webfinger';
import { Create, Image, Mention, Note, PUBLIC_COLLECTION } from '@fedify/vocab';
import type { Knex } from 'knex';
import { z } from 'zod';

import type { AccountService } from '@/account/account.service';
import type { FedifyContextFactory } from '@/activitypub/fedify-context.factory';
import type { FedifyContext } from '@/app';
import { container } from '@/configuration/container';
import { registerDependencies } from '@/configuration/registrations';
import { getError, isError } from '@/core/result';
import { knex } from '@/db';
import type { PostService } from '@/post/post.service';

const OUTBOX_ORIGINAL = 0;
const OUTBOX_REPOST = 1;
const OUTBOX_REPLY = 2;
const NOTIFICATION_TYPES: Record<string, number> = {
    like: 1,
    reply: 2,
    repost: 3,
    follow: 4,
    mention: 5,
};

class DryRun extends Error {}

// The export fields this script reads. Everything else passes through.
const ExportPost = z.looseObject({
    id: z.string(),
    publishedAt: z.string(),
    repostedBy: z.looseObject({ handle: z.string() }).nullish(),
});
const ExportProfile = z.looseObject({ apId: z.string(), handle: z.string() });
const ExportThread = z.looseObject({
    post: ExportPost.optional(),
    ancestors: z.looseObject({ chain: z.array(ExportPost) }).optional(),
    children: z
        .array(z.looseObject({ post: ExportPost, chain: z.array(ExportPost).optional() }))
        .optional(),
});
const ActivityObject = z.looseObject({ id: z.string() });
const OutboxItem = z.looseObject({
    '@context': z.unknown(),
    id: z.string(),
    type: z.string(),
    actor: z.string(),
    object: z.union([z.string(), ActivityObject]),
});
const Notification = z.looseObject({
    createdAt: z.string(),
    type: z.string(),
    actor: z.looseObject({ handle: z.string() }),
    post: ExportPost.pick({ id: true }).nullish(),
    inReplyTo: ExportPost.pick({ id: true }).nullish(),
});
const MediaEntry = z.looseObject({ url: z.string(), file: z.string() });
const ExportAccount = z.looseObject({
    handle: z.string(),
    name: z.string().nullable(),
    bio: z.string().nullable(),
    url: z.string(),
    avatarUrl: z.string().nullable(),
    bannerImageUrl: z.string().nullable(),
    blueskyEnabled: z.boolean().optional(),
    blueskyHandle: z.string().nullish(),
    blueskyHandleConfirmed: z.boolean().optional(),
});
const Preferences = z.looseObject({ showSensitiveMedia: z.boolean().optional() });
const MappingsFile = z.object({
    site_uuid: z.string(),
    posts: z.array(z.object({ ghost_uuid: z.string(), ap_id: z.string() })),
});
const Handles = z.record(z.string(), z.string());

type ExportPost = z.infer<typeof ExportPost>;
type OutboxItem = z.infer<typeof OutboxItem>;

interface Export {
    account: z.infer<typeof ExportAccount>;
    preferences: z.infer<typeof Preferences>;
    actorId: string;
    followers: z.infer<typeof ExportProfile>[];
    following: z.infer<typeof ExportProfile>[];
    posts: ExportPost[];
    liked: ExportPost[];
    notifications: z.infer<typeof Notification>[];
    outboxItems: OutboxItem[];
    media: z.infer<typeof MediaEntry>[];
    /** Every post the export shows, by ap_id */
    referenced: Set<string>;
}

function load<T extends z.ZodType>(schema: T, path: string): z.infer<T> {
    return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function log(...args: unknown[]) {
    console.log(new Date().toISOString(), ...args);
}

function loadExport(dir: string): Export {
    const at = (file: string) => join(dir, file);
    const posts = load(z.array(ExportPost), at('posts.json'));
    const notes = load(z.array(ExportPost), at('notes.json'));
    const liked = load(z.array(ExportPost), at('liked.json'));
    const notifications = load(z.array(Notification), at('notifications.json'));
    const outbox = load(
        z.looseObject({ pages: z.array(z.looseObject({ orderedItems: z.array(OutboxItem) })) }),
        at('activitypub/outbox.json'),
    );
    const threads = ['replies.json', 'my-replies.json', 'conversations.json'].flatMap((f) =>
        load(z.array(ExportThread), at(f)),
    );

    const referenced = new Set<string>();
    for (const p of [...posts, ...notes, ...liked]) referenced.add(p.id);
    for (const t of threads) {
        for (const p of t.ancestors?.chain ?? []) referenced.add(p.id);
        if (t.post) referenced.add(t.post.id);
        for (const c of t.children ?? []) {
            referenced.add(c.post.id);
            for (const p of c.chain ?? []) referenced.add(p.id);
        }
    }
    for (const n of notifications) {
        if (n.post) referenced.add(n.post.id);
        if (n.inReplyTo) referenced.add(n.inReplyTo.id);
    }

    return {
        account: load(ExportAccount, at('account.json')),
        preferences: load(Preferences, at('preferences.json')),
        actorId: load(z.looseObject({ id: z.string() }), at('activitypub/actor.json')).id,
        followers: load(z.array(ExportProfile), at('followers.json')),
        following: load(z.array(ExportProfile), at('following.json')),
        posts,
        liked,
        notifications,
        outboxItems: outbox.pages.flatMap((p) => p.orderedItems),
        media: load(z.array(MediaEntry), at('media/index.json')),
        referenced,
    };
}

function resolveContainer() {
    registerDependencies(container, { knex });
    return {
        accountService: container.resolve<AccountService>('accountService'),
        postService: container.resolve<PostService>('postService'),
        fedifyContextFactory: container.resolve<FedifyContextFactory>(
            'fedifyContextFactory',
        ),
    };
}

/**
 * The services only need a document loader and a logger from the Fedify
 * context. Sign fetches as the internal account of signHost so servers with
 * authorized fetch answer too.
 */
async function makeContext(db: Knex, signHost: string): Promise<FedifyContext> {
    const row = await db('accounts')
        .join('users', 'users.account_id', 'accounts.id')
        .join('sites', 'sites.id', 'users.site_id')
        .where('sites.host', signHost)
        .first('accounts.ap_id', 'accounts.ap_private_key');
    if (!row?.ap_private_key) {
        throw new Error(`No internal account with a key for ${signHost}`);
    }
    const privateKey = await importJwk(JSON.parse(row.ap_private_key), 'private');
    const documentLoader = getAuthenticatedDocumentLoader({
        keyId: new URL(`${row.ap_id}#main-key`),
        privateKey,
    });
    const logger = {
        debug: () => {},
        info: (...a: unknown[]) => log('info', ...a),
        warn: (...a: unknown[]) => log('warn', ...a),
        error: (...a: unknown[]) => log('error', ...a),
    };
    return {
        getDocumentLoader: async () => documentLoader,
        documentLoader,
        data: { logger },
    } as unknown as FedifyContext;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
    let i = 0;
    await Promise.all(
        Array.from({ length: limit }, async () => {
            while (i < items.length) {
                await fn(items[i++]);
            }
        }),
    );
}

async function existingApIds(db: Knex, table: 'accounts' | 'posts', apIds: string[]) {
    const found = new Map<string, number>();
    for (let i = 0; i < apIds.length; i += 500) {
        const chunk = apIds.slice(i, i + 500);
        const rows = await db(table)
            .whereRaw(
                `ap_id_hash IN (${chunk.map(() => 'UNHEX(SHA2(?, 256))').join(',')})`,
                chunk,
            )
            .select('id', 'ap_id');
        for (const r of rows) found.set(r.ap_id, r.id);
    }
    return found;
}

function handleMap(ex: Export, dir: string) {
    const map = new Map<string, string>();
    for (const a of [...ex.followers, ...ex.following]) {
        map.set(a.handle.toLowerCase(), a.apId);
    }
    const file = join(dir, 'handles.json');
    if (existsSync(file)) {
        for (const [h, id] of Object.entries(load(Handles, file))) map.set(h, id);
    }
    return map;
}

// ---------------------------------------------------------------- prepare

async function prepare(dir: string, signHost: string) {
    const ex = loadExport(dir);
    const { accountService, postService, fedifyContextFactory } = resolveContainer();
    const ctx = await makeContext(knex, signHost);

    await fedifyContextFactory.registerContext(ctx, async () => {
        // 1. The account itself, so cutover has a row to make local
        const self = await accountService.ensureByApId(new URL(ex.actorId));
        if (isError(self)) {
            throw new Error(`Could not fetch ${ex.actorId}: ${getError(self)}`);
        }

        // 2. Accounts from the follower and following lists
        const accountIds = [
            ...new Set([...ex.followers, ...ex.following].map((a) => a.apId)),
        ];
        const known = await existingApIds(knex, 'accounts', accountIds);
        const missing = accountIds.filter((id) => !known.has(id));
        log(`accounts: ${accountIds.length} in lists, ${missing.length} missing`);
        await mapLimit(missing, 5, async (id) => {
            const result = await accountService.ensureByApId(new URL(id));
            log(isError(result) ? `  account FAILED ${getError(result)}` : '  account ok', id);
        });

        // 3. Notification actors only come with a handle: resolve by WebFinger
        const handles = handleMap(ex, dir);
        const unresolved = [
            ...new Set(ex.notifications.map((n) => n.actor.handle.toLowerCase())),
        ].filter((h) => !handles.has(h));
        log(`notification actors: ${unresolved.length} handles to resolve`);
        await mapLimit(unresolved, 5, async (handle) => {
            try {
                const jrd = await lookupWebFinger(`acct:${handle.replace(/^@/, '')}`);
                const self = jrd?.links?.find(
                    (l) =>
                        l.rel === 'self' &&
                        (l.type === 'application/activity+json' ||
                            l.type?.startsWith('application/ld+json')),
                );
                if (!self?.href) {
                    log('  handle FAILED no self link', handle);
                    return;
                }
                const result = await accountService.ensureByApId(new URL(self.href));
                if (isError(result)) {
                    log(`  handle FAILED ${getError(result)}`, handle);
                    return;
                }
                handles.set(handle, self.href);
            } catch (err) {
                log(`  handle FAILED ${err}`, handle);
            }
        });
        writeFileSync(
            join(dir, 'handles.json'),
            JSON.stringify(Object.fromEntries(handles), null, 2),
        );

        // 4. Posts the export shows that the DB does not have
        const postIds = [...ex.referenced];
        const knownPosts = await existingApIds(knex, 'posts', postIds);
        const missingPosts = postIds.filter((id) => !knownPosts.has(id));
        log(`posts: ${postIds.length} referenced, ${missingPosts.length} missing`);
        let ok = 0;
        let failed = 0;
        await mapLimit(missingPosts, 5, async (id) => {
            try {
                const result = await postService.getByApId(new URL(id));
                if (isError(result)) {
                    failed++;
                    log(`  post FAILED ${getError(result)}`, id);
                } else {
                    ok++;
                }
            } catch (err) {
                failed++;
                log(`  post FAILED ${err}`, id);
            }
        });
        log(`posts: ${ok} imported, ${failed} failed`);
    });
}

// ---------------------------------------------------------------- mappings

const ExportArticle = z.looseObject({
    id: z.string(),
    type: z.number(),
    url: z.string(),
    authoredByMe: z.boolean().optional(),
    repostedBy: z.unknown().optional(),
});
const GhostSite = z.looseObject({ site: z.looseObject({ site_uuid: z.string() }) });
const GhostPosts = z.looseObject({
    posts: z.array(z.looseObject({ uuid: z.string(), slug: z.string() })),
    meta: z.looseObject({
        pagination: z.looseObject({ next: z.number().nullable() }),
    }),
});

async function getJson<T extends z.ZodType>(schema: T, url: string): Promise<z.infer<T>> {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return schema.parse(await res.json());
}

function slugOf(url: string) {
    return new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
}

async function mappings(dir: string, ghostUrl: string, contentApiKey: string) {
    const base = new URL(ghostUrl);
    // The same UUID the ActivityPub server reads when Ghost registers a site
    const site = await getJson(GhostSite, new URL('/ghost/api/admin/site/', base).href);
    // Ghost caps limit=all at 100, so page through
    const uuidBySlug = new Map<string, string>();
    for (let page: number | null = 1; page !== null; ) {
        const postsUrl = new URL('/ghost/api/content/posts/', base);
        postsUrl.search = new URLSearchParams({
            key: contentApiKey,
            fields: 'uuid,slug',
            limit: '100',
            page: String(page),
        }).toString();
        const res = await getJson(GhostPosts, postsUrl.href);
        for (const p of res.posts) uuidBySlug.set(p.slug, p.uuid);
        page = res.meta.pagination.next;
    }

    const articles = load(z.array(ExportArticle), join(dir, 'posts.json')).filter(
        (p) => p.type === 1 && p.authoredByMe && !p.repostedBy,
    );
    const posts: { ghost_uuid: string; ap_id: string }[] = [];
    for (const a of articles) {
        const uuid = uuidBySlug.get(slugOf(a.url));
        if (uuid) posts.push({ ghost_uuid: uuid, ap_id: a.id });
        else log('  no Ghost post for', a.url);
    }
    writeFileSync(
        join(dir, 'mappings.json'),
        JSON.stringify({ site_uuid: site.site.site_uuid, posts }, null, 2),
    );
    log(
        `mappings: site ${site.site.site_uuid}, ${posts.length} of ${articles.length} articles matched`,
    );
}

// ---------------------------------------------------------------- cutover

async function cutover(dir: string, commit: boolean) {
    const ex = loadExport(dir);
    const apId = ex.actorId;
    const host = new URL(apId).host;
    const handles = handleMap(ex, dir);
    const mappingsPath = join(dir, 'mappings.json');
    if (!existsSync(mappingsPath)) throw new Error(`${mappingsPath} missing: run mappings first`);
    const { site_uuid: ghostUuid, posts: mappings } = load(MappingsFile, mappingsPath);
    const stats: Record<string, number | string> = {};

    try {
        await knex.transaction(async (trx) => {
            // 1. Site row for the actor's host (same as SiteService.createSite
            //    after the previous owner of the Ghost site UUID released it)
            let site = await trx('sites').where({ host }).first();
            if (!site) {
                await trx('sites')
                    .where({ ghost_uuid: ghostUuid })
                    .update({ ghost_uuid: null });
                const [id] = await trx('sites').insert({
                    host,
                    webhook_secret: randomBytes(32).toString('hex'),
                    ghost_pro: false,
                    ghost_uuid: ghostUuid,
                });
                site = await trx('sites').where({ id }).first();
                stats.site = `created ${id}`;
            } else if (site.ghost_uuid !== ghostUuid) {
                await trx('sites')
                    .where({ ghost_uuid: ghostUuid })
                    .update({ ghost_uuid: null });
                await trx('sites').where({ id: site.id }).update({ ghost_uuid: ghostUuid });
                stats.site = `exists ${site.id}, ghost_uuid ${site.ghost_uuid} -> ${ghostUuid}`;
            } else {
                stats.site = `exists ${site.id}`;
            }

            // 2. The account: same as AccountService.createInternalAccount on an
            //    existing external account (new key pair, users row)
            const account = await trx('accounts')
                .whereRaw('ap_id_hash = UNHEX(SHA2(?, 256))', [apId])
                .first();
            if (!account) throw new Error(`No account row for ${apId}`);
            const accountId: number = account.id;

            let user = await trx('users').where({ account_id: accountId }).first();
            const otherUser = await trx('users').where({ site_id: site.id }).first();
            if (otherUser && otherUser.account_id !== accountId) {
                throw new Error(
                    `Site ${site.id} already has account ${otherUser.account_id}; resolve before importing`,
                );
            }
            if (!account.ap_private_key) {
                const keyPair = await generateCryptoKeyPair();
                await trx('accounts')
                    .where({ id: accountId })
                    .update({
                        ap_public_key: JSON.stringify(await exportJwk(keyPair.publicKey)),
                        ap_private_key: JSON.stringify(await exportJwk(keyPair.privateKey)),
                    });
                stats.keys = 'generated';
            } else {
                stats.keys = 'kept';
            }
            if (!user) {
                const [id] = await trx('users').insert({
                    account_id: accountId,
                    site_id: site.id,
                    show_sensitive_media: ex.preferences.showSensitiveMedia ? 1 : 0,
                });
                user = await trx('users').where({ id }).first();
                stats.user = `created ${id}`;
            } else {
                stats.user = `exists ${user.id}`;
            }
            const userId: number = user.id;

            // Profile as it was on the old server
            await trx('accounts')
                .where({ id: accountId })
                .update({
                    name: ex.account.name,
                    bio: ex.account.bio,
                    url: ex.account.url,
                    avatar_url: ex.account.avatarUrl,
                    banner_image_url: ex.account.bannerImageUrl,
                });

            // 3. Follows
            const listIds = [
                ...new Set([...ex.followers, ...ex.following].map((a) => a.apId)),
            ];
            const accountIdByApId = await existingApIds(trx, 'accounts', listIds);
            const followRows: { follower_id: number; following_id: number }[] = [];
            const missingAccounts: string[] = [];
            for (const f of ex.followers) {
                const id = accountIdByApId.get(f.apId);
                if (id) followRows.push({ follower_id: id, following_id: accountId });
                else missingAccounts.push(f.apId);
            }
            for (const f of ex.following) {
                const id = accountIdByApId.get(f.apId);
                if (id) followRows.push({ follower_id: accountId, following_id: id });
                else missingAccounts.push(f.apId);
            }
            const followsBefore = await trx('follows')
                .where({ following_id: accountId })
                .orWhere({ follower_id: accountId })
                .count({ n: '*' })
                .first();
            if (followRows.length) {
                await trx('follows').insert(followRows).onConflict().ignore();
            }
            const followsAfter = await trx('follows')
                .where({ following_id: accountId })
                .orWhere({ follower_id: accountId })
                .count({ n: '*' })
                .first();
            stats.follows_added = Number(followsAfter?.n) - Number(followsBefore?.n);
            stats.follows_missing_accounts = missingAccounts.length;
            if (missingAccounts.length) log('accounts not in DB:', missingAccounts);

            // 4. Likes and reposts by the account
            const postIdByApId = await existingApIds(trx, 'posts', [...ex.referenced]);
            let likesAdded = 0;
            for (const p of ex.liked) {
                const postId = postIdByApId.get(p.id);
                if (!postId) continue;
                const exists = await trx('likes').where({ account_id: accountId, post_id: postId }).first();
                if (exists) continue;
                await trx('likes').insert({ account_id: accountId, post_id: postId });
                await trx('posts').where({ id: postId }).increment('like_count', 1);
                likesAdded++;
            }
            stats.likes_added = likesAdded;
            stats.likes_missing_posts = ex.liked.filter((p) => !postIdByApId.has(p.id)).length;

            let repostsAdded = 0;
            const reposted = ex.posts.filter((p) => p.repostedBy && p.repostedBy.handle === ex.account.handle);
            for (const p of reposted) {
                const postId = postIdByApId.get(p.id);
                if (!postId) continue;
                const exists = await trx('reposts').where({ account_id: accountId, post_id: postId }).first();
                if (exists) continue;
                await trx('reposts').insert({
                    account_id: accountId,
                    post_id: postId,
                    created_at: new Date(p.publishedAt),
                });
                await trx('posts').where({ id: postId }).increment('repost_count', 1);
                repostsAdded++;
            }
            stats.reposts_added = repostsAdded;
            stats.reposts_missing_posts = reposted.filter((p) => !postIdByApId.has(p.id)).length;

            // 5. Outbox (written at save time for internal accounts only)
            // affectedRows counts matched duplicates too (FOUND_ROWS), so diff counts
            const outboxCount = async () =>
                Number((await trx('outboxes').where({ account_id: accountId }).count({ n: '*' }).first())?.n);
            const outboxBefore = await outboxCount();
            await trx.raw(
                `INSERT INTO outboxes (account_id, post_id, post_type, outbox_type, published_at, author_id)
                 SELECT ?, p.id, p.type, IF(p.in_reply_to IS NULL, ?, ?), p.published_at, p.author_id
                 FROM posts p
                 WHERE p.author_id = ? AND p.deleted_at IS NULL AND p.type IN (0, 1)
                 ON DUPLICATE KEY UPDATE outboxes.id = outboxes.id`,
                [accountId, OUTBOX_ORIGINAL, OUTBOX_REPLY, accountId],
            );
            await trx.raw(
                `INSERT INTO outboxes (account_id, post_id, post_type, outbox_type, published_at, author_id)
                 SELECT ?, p.id, p.type, ?, r.created_at, p.author_id
                 FROM reposts r JOIN posts p ON p.id = r.post_id
                 WHERE r.account_id = ? AND p.deleted_at IS NULL AND p.type IN (0, 1)
                 ON DUPLICATE KEY UPDATE outboxes.id = outboxes.id`,
                [accountId, OUTBOX_REPOST, accountId],
            );
            stats.outbox_rows_added = (await outboxCount()) - outboxBefore;

            // 6. Feed: what FeedService.addPostToFeeds would have given this user
            //    (own and followed accounts' top-level posts and reposts)
            const [fd1] = await trx.raw(
                `INSERT INTO feeds (post_type, audience, user_id, post_id, author_id, reposted_by_id, published_at)
                 SELECT p.type, p.audience, ?, p.id, p.author_id, NULL, p.published_at
                 FROM posts p
                 WHERE (p.author_id = ? OR p.author_id IN (SELECT following_id FROM follows WHERE follower_id = ?))
                   AND p.in_reply_to IS NULL AND p.deleted_at IS NULL AND p.type IN (0, 1)
                   AND p.audience IN (0, 1) AND p.published_at <= NOW()
                   AND NOT EXISTS (SELECT 1 FROM feeds f WHERE f.user_id = ? AND f.post_id = p.id AND f.reposted_by_id IS NULL)`,
                [userId, accountId, accountId, userId],
            );
            const [fd2] = await trx.raw(
                `INSERT INTO feeds (post_type, audience, user_id, post_id, author_id, reposted_by_id, published_at)
                 SELECT p.type, p.audience, ?, p.id, p.author_id, r.account_id, r.created_at
                 FROM reposts r JOIN posts p ON p.id = r.post_id
                 WHERE (r.account_id = ? OR r.account_id IN (SELECT following_id FROM follows WHERE follower_id = ?))
                   AND p.in_reply_to IS NULL AND p.deleted_at IS NULL AND p.type IN (0, 1)
                   AND p.audience IN (0, 1)
                   AND NOT EXISTS (SELECT 1 FROM feeds f WHERE f.user_id = ? AND f.post_id = p.id AND f.reposted_by_id = r.account_id)`,
                [userId, accountId, accountId, userId],
            );
            stats.feed_rows_added = fd1.affectedRows + fd2.affectedRows;

            // 7. Notifications (historical, so marked read)
            const actorApIds = [
                ...new Set(
                    ex.notifications
                        .map((n) => handles.get(n.actor.handle.toLowerCase()))
                        .filter((x): x is string => !!x),
                ),
            ];
            const actorIdByApId = await existingApIds(trx, 'accounts', actorApIds);
            const existingRows: { event_type: number; account_id: number; post_id: number | null; created_at: Date }[] =
                await trx('notifications')
                    .where({ user_id: userId })
                    .select('event_type', 'account_id', 'post_id', 'created_at');
            const existing = new Set(
                existingRows.map((r) => `${r.event_type}|${r.account_id}|${r.post_id}|${new Date(r.created_at).getTime()}`),
            );
            const skipped: Record<string, number> = {};
            const notificationRows: {
                created_at: Date;
                event_type: number;
                user_id: number;
                account_id: number;
                post_id: number | null;
                in_reply_to_post_id: number | null;
                read: number;
            }[] = [];
            for (const n of ex.notifications) {
                const type = NOTIFICATION_TYPES[n.type];
                const actorApId = handles.get(n.actor.handle.toLowerCase());
                const actorId = actorApId ? actorIdByApId.get(actorApId) : undefined;
                const postId = n.post ? postIdByApId.get(n.post.id) : null;
                const inReplyToId = n.inReplyTo ? postIdByApId.get(n.inReplyTo.id) : null;
                const reason = !type
                    ? `type ${n.type}`
                    : !actorId
                      ? 'actor'
                      : n.post && !postId
                        ? 'post'
                        : n.inReplyTo && !inReplyToId
                          ? 'inReplyTo'
                          : null;
                if (reason) {
                    skipped[reason] = (skipped[reason] ?? 0) + 1;
                    continue;
                }
                const createdAt = new Date(n.createdAt);
                const key = `${type}|${actorId}|${postId ?? null}|${createdAt.getTime()}`;
                if (existing.has(key)) continue;
                existing.add(key);
                notificationRows.push({
                    created_at: createdAt,
                    event_type: type,
                    user_id: userId,
                    account_id: actorId,
                    post_id: postId ?? null,
                    in_reply_to_post_id: inReplyToId ?? null,
                    read: 1,
                });
            }
            // Oldest first so ids follow time, as the UI orders by id
            notificationRows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
            for (let i = 0; i < notificationRows.length; i += 500) {
                await trx('notifications').insert(notificationRows.slice(i, i + 500));
            }
            stats.notifications_added = notificationRows.length;
            stats.notifications_skipped = JSON.stringify(skipped);

            // 8. Ghost post -> article mappings, so edits and deletes in Ghost
            //    reach the existing articles
            let mappingsAdded = 0;
            for (const m of mappings) {
                const taken = await trx('ghost_ap_post_mappings')
                    .where({ ghost_uuid: m.ghost_uuid })
                    .orWhereRaw('ap_id_hash = UNHEX(SHA2(?, 256))', [m.ap_id])
                    .first();
                if (taken) continue;
                await trx('ghost_ap_post_mappings').insert(m);
                mappingsAdded++;
            }
            stats.mappings_added = mappingsAdded;

            // 9. Stored objects, so note/article/create/announce URLs keep resolving
            let objectsAdded = 0;
            const putObject = async (id: string, value: unknown) => {
                const key = JSON.stringify([id]);
                const exists = await trx('key_value').where({ key }).first('id');
                if (exists) return;
                await trx('key_value').insert({ key, value: JSON.stringify(value) });
                objectsAdded++;
            };
            for (const item of ex.outboxItems) {
                if (item.actor !== apId) continue;
                await putObject(item.id, item);
                if (item.type === 'Create' && typeof item.object === 'object') {
                    await putObject(item.object.id, {
                        '@context': item['@context'],
                        ...item.object,
                    });
                }
            }
            stats.objects_added = objectsAdded;

            // 10. Bluesky bridge state
            if (ex.account.blueskyEnabled && ex.account.blueskyHandle) {
                const exists = await trx('bluesky_integration_account_handles')
                    .where({ account_id: accountId })
                    .first();
                if (!exists) {
                    await trx('bluesky_integration_account_handles').insert({
                        account_id: accountId,
                        handle: ex.account.blueskyHandle,
                        confirmed: ex.account.blueskyHandleConfirmed ? 1 : 0,
                    });
                    stats.bluesky = 'added';
                } else {
                    stats.bluesky = 'exists';
                }
            }

            // 11. Cached copies of the old actor and key
            const cacheKeys = [
                [apId],
                ['_fedify', 'publicKey', `${apId}#main-key`],
                ['_fedify', 'publicKey', '3', `${apId}#main-key`],
                ['_fedify', 'publicKey', '__fetchError', `${apId}#main-key`],
            ].map((k) => JSON.stringify(k));
            stats.cache_entries_deleted = await trx('key_value').whereIn('key', cacheKeys).del();

            // Report
            const counts = await trx.raw(
                `SELECT
                   (SELECT COUNT(*) FROM follows WHERE following_id = ?) AS followers,
                   (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following,
                   (SELECT COUNT(*) FROM outboxes WHERE account_id = ?) AS outbox,
                   (SELECT COUNT(*) FROM feeds WHERE user_id = ?) AS feed,
                   (SELECT COUNT(*) FROM notifications WHERE user_id = ?) AS notifications,
                   (SELECT COUNT(*) FROM likes WHERE account_id = ?) AS likes,
                   (SELECT COUNT(*) FROM reposts WHERE account_id = ?) AS reposts,
                   (SELECT COUNT(*) FROM posts WHERE author_id = ? AND deleted_at IS NULL) AS posts`,
                Array(8).fill(0).map((_, i) => (i === 3 || i === 4 ? userId : accountId)),
            );
            Object.assign(stats, { account_id: accountId, user_id: userId, site_id: site.id }, counts[0][0]);

            if (!commit) throw new DryRun();
        });
        log(commit ? 'COMMITTED' : 'done');
    } catch (err) {
        if (!(err instanceof DryRun)) throw err;
        log('DRY RUN, rolled back');
    }
    console.log(JSON.stringify(stats, null, 2));
}

// ---------------------------------------------------------------- media

async function media(dir: string, commit: boolean) {
    const ex = loadExport(dir);
    const account: { id: number; uuid: string } | undefined = await knex('accounts')
        .whereRaw('ap_id_hash = UNHEX(SHA2(?, 256))', [ex.actorId])
        .first('id', 'uuid');
    if (!account) throw new Error(`No account row for ${ex.actorId}`);
    // Same settings the server's LocalStorageAdapter uses
    const contentRoot = process.env.LOCAL_STORAGE_PATH;
    const hostingUrl = process.env.LOCAL_STORAGE_HOSTING_URL;
    if (!contentRoot || !hostingUrl) {
        throw new Error('media needs local storage: LOCAL_STORAGE_PATH and LOCAL_STORAGE_HOSTING_URL');
    }

    const moves = ex.media
        .filter((m) => m.url.startsWith('https://storage.googleapis.com/'))
        .map((m) => ({
            from: m.url,
            file: m.file,
            to: `${hostingUrl}/images/${account.uuid}/${m.file}`,
        }));
    log(`media: ${moves.length} bucket files`);

    // Files first: extra files are harmless, URLs pointing at missing files are not
    if (commit) {
        const target = join(contentRoot, 'images', account.uuid);
        mkdirSync(target, { recursive: true });
        for (const m of moves) copyFileSync(join(dir, 'media', m.file), join(target, m.file));
        log(`media: copied ${moves.length} files to ${target}`);
    }

    const ownObjectKeys = ex.outboxItems
        .filter((i) => i.actor === ex.actorId)
        .flatMap((i) => [i.id, typeof i.object === 'object' ? i.object.id : null])
        .filter((x): x is string => !!x)
        .map((id) => JSON.stringify([id]));

    await knex.transaction(async (trx) => {
        let posts = 0;
        let objects = 0;
        for (const m of moves) {
            const [r1] = await trx.raw(
                `UPDATE posts SET
                   attachments = CAST(REPLACE(CAST(attachments AS CHAR), ?, ?) AS JSON),
                   content = REPLACE(content, ?, ?),
                   image_url = REPLACE(image_url, ?, ?)
                 WHERE author_id = ? AND (
                   CAST(attachments AS CHAR) LIKE CONCAT('%', ?, '%')
                   OR content LIKE CONCAT('%', ?, '%') OR image_url = ?)`,
                [m.from, m.to, m.from, m.to, m.from, m.to, account.id, m.from, m.from, m.from],
            );
            posts += r1.affectedRows;
            const [r2] = await trx.raw(
                `UPDATE key_value SET value = CAST(REPLACE(CAST(value AS CHAR), ?, ?) AS JSON)
                 WHERE \`key\` IN (${ownObjectKeys.map(() => '?').join(',')})
                   AND CAST(value AS CHAR) LIKE CONCAT('%', ?, '%')`,
                [m.from, m.to, ...ownObjectKeys, m.from],
            );
            objects += r2.affectedRows;
        }
        log(`media: ${posts} post rows, ${objects} stored objects rewritten`);
        if (!commit) throw new DryRun();
    }).catch((err) => {
        if (!(err instanceof DryRun)) throw err;
        log('DRY RUN, rolled back');
    });
}

// ---------------------------------------------------------------- objects

const Attachments = z
    .array(z.looseObject({ type: z.string(), url: z.string(), name: z.string().nullish() }))
    .nullable();

async function objects(dir: string, commit: boolean) {
    const apId = loadExport(dir).actorId;
    const account: { id: number; ap_followers_url: string } | undefined = await knex('accounts')
        .whereRaw('ap_id_hash = UNHEX(SHA2(?, 256))', [apId])
        .first('id', 'ap_followers_url');
    if (!account) throw new Error(`No account row for ${apId}`);

    const rows: {
        id: number;
        type: number;
        ap_id: string;
        content: string | null;
        summary: string | null;
        published_at: Date;
        updated_at: Date | null;
        attachments: unknown;
        parent_ap_id: string | null;
    }[] = await knex('posts as p')
        .leftJoin('posts as parent', 'parent.id', 'p.in_reply_to')
        .leftJoin('key_value as k', 'k.key', knex.raw(`CONCAT('["', p.ap_id, '"]')`))
        .where('p.author_id', account.id)
        .whereNull('p.deleted_at')
        .whereNull('k.id')
        .select(
            'p.id',
            'p.type',
            'p.ap_id',
            'p.content',
            'p.summary',
            'p.published_at',
            'p.updated_at',
            'p.attachments',
            'parent.ap_id as parent_ap_id',
        );
    const notes = rows.filter((r) => r.type === 0 && r.ap_id.includes('/note/'));
    log(`objects: ${rows.length} posts without a stored object, ${notes.length} notes to build`);
    for (const r of rows.filter((r) => !notes.includes(r))) log('  skipped', r.type, r.ap_id);

    let stored = 0;
    for (const r of notes) {
        const mentioned: { ap_id: string; username: string; domain: string }[] = await knex('mentions')
            .join('accounts', 'accounts.id', 'mentions.account_id')
            .where('mentions.post_id', r.id)
            .select('accounts.ap_id', 'accounts.username', 'accounts.domain');
        const mentions = mentioned.map(
            (m) => new Mention({ name: `@${m.username}@${m.domain}`, href: new URL(m.ap_id) }),
        );
        const ccs = [new URL(account.ap_followers_url), ...mentions.map((m) => m.href!)];
        const published = Temporal.Instant.from(new Date(r.published_at).toISOString());
        // Same shape as helpers/activitypub/activity.ts builds for notes, plus
        // the reply target, which that builder leaves out
        const note = new Note({
            id: new URL(r.ap_id),
            attribution: new URL(apId),
            content: r.content,
            summary: r.summary,
            published,
            updated: r.updated_at
                ? Temporal.Instant.from(new Date(r.updated_at).toISOString())
                : published,
            replyTarget: r.parent_ap_id ? new URL(r.parent_ap_id) : null,
            attachments: (Attachments.parse(r.attachments) ?? [])
                .filter((a) => a.type === 'Image')
                .map((a) => new Image({ url: new URL(a.url), name: a.name ?? null })),
            tags: mentions,
            to: PUBLIC_COLLECTION,
            ccs,
        });
        // Ghost names a note's Create after the note: /note/<id> -> /create/<id>
        const create = new Create({
            id: new URL(r.ap_id.replace('/note/', '/create/')),
            actor: new URL(apId),
            object: note,
            to: PUBLIC_COLLECTION,
            ccs,
        });
        if (!commit) continue;
        for (const [id, value] of [
            [r.ap_id, await note.toJsonLd()],
            [create.id!.href, await create.toJsonLd()],
        ] as const) {
            const key = JSON.stringify([id]);
            if (await knex('key_value').where({ key }).first('id')) continue;
            await knex('key_value').insert({ key, value: JSON.stringify(value) });
            stored++;
        }
    }
    log(commit ? `objects: stored ${stored}` : 'DRY RUN, nothing stored');
}

// ---------------------------------------------------------------- main

const [command, ...args] = process.argv.slice(2);
const commit = args.includes('--commit');
const positional = args.filter((a) => !a.startsWith('--'));

try {
    if (command === 'prepare') await prepare(positional[0], positional[1]);
    else if (command === 'mappings') await mappings(positional[0], positional[1], positional[2]);
    else if (command === 'cutover') await cutover(positional[0], commit);
    else if (command === 'media') await media(positional[0], commit);
    else if (command === 'objects') await objects(positional[0], commit);
    else throw new Error(`unknown command ${command}`);
} finally {
    await knex.destroy();
}
process.exit(0);
