#!/usr/bin/env node
// Runs src/importer.ts against a running TryGhost/ActivityPub container.
//
// The importer uses the server's own services, so it has to be built against
// the server's source and run with the server's environment. This CLI does
// both without touching the running container:
//
// 1. reads the container's image, environment and source revision
// 2. downloads TryGhost/ActivityPub at that revision (cached) and bundles the
//    importer against it with esbuild
// 3. copies the export and the bundle into a temporary Docker volume
// 4. runs the bundle in a one-off container from the same image, on the same
//    network and with the same volumes and environment
// 5. copies the files the importer writes (handles.json, mappings.json) back
//    into the export directory, and removes the volume
//
// Everything goes through the docker CLI, so DOCKER_HOST=ssh://… or a docker
// context works for a server elsewhere.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import * as esbuild from 'esbuild';

const IMPORTER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'importer.ts');
const OUTPUTS = ['handles.json', 'mappings.json'];

const USAGE = `Usage: ghost-activitypub-importer <command> --container <name> --export <dir> [options]

Commands, in the order you run them:
  prepare   --sign-host <host>          fetch the account and everything the export refers to
  mappings  --ghost-url <url> --content-api-key <key>
                                        match the account's articles to posts on the new Ghost site
  cutover   [--commit]                  make the account local and restore follows, likes, posts…
  media     [--commit]                  copy the exported images into the server's local storage
  objects   [--commit]                  store missing ActivityPub objects for the account's notes

Options:
  --container <name>   the running ActivityPub server container
  --export <dir>       the unpacked ghost-activitypub-exporter export
  --commit             write to the database (cutover, media, objects); without it they only report
  --revision <sha>     TryGhost/ActivityPub revision, if the image has no revision label
  --source <dir>       a local TryGhost/ActivityPub checkout instead of downloading one

For a server elsewhere, set DOCKER_HOST=ssh://user@host or use a docker context.`;

const COMMANDS = {
    prepare: { required: ['sign-host'], args: (o) => [o['sign-host']] },
    mappings: {
        required: ['ghost-url', 'content-api-key'],
        args: (o) => [o['ghost-url'], o['content-api-key']],
    },
    cutover: { required: [], args: () => [], commit: true },
    media: { required: [], args: () => [], commit: true },
    objects: { required: [], args: () => [], commit: true },
};

function fail(message) {
    console.error(`ghost-activitypub-importer: ${message}`);
    process.exit(1);
}

/** Runs a command. Resolves with stdout when `capture` is set. */
function run(cmd, args, { capture = false, stdin } = {}) {
    return new Promise((done, reject) => {
        const child = spawn(cmd, args, {
            stdio: [stdin ? 'pipe' : 'ignore', capture ? 'pipe' : 'inherit', 'inherit'],
        });
        const chunks = [];
        if (capture) child.stdout.on('data', (c) => chunks.push(c));
        if (stdin) stdin.pipe(child.stdin);
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) done(Buffer.concat(chunks));
            else reject(new Error(`${cmd} ${args[0]} exited with ${code}`));
        });
    });
}

/** Pipes `from`'s stdout into `to`'s stdin. */
async function pipe([fromCmd, fromArgs], [toCmd, toArgs]) {
    const from = spawn(fromCmd, fromArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((done, reject) => {
        from.on('error', reject);
        from.on('close', (code) =>
            code === 0 ? done() : reject(new Error(`${fromCmd} exited with ${code}`)),
        );
    });
    await Promise.all([run(toCmd, toArgs, { stdin: from.stdout }), exited]);
}

async function docker(args, opts) {
    return run('docker', args, opts);
}

async function inspectContainer(name) {
    const [c] = JSON.parse(await docker(['inspect', '--type', 'container', name], { capture: true }));
    if (!c.State.Running) fail(`container ${name} is not running`);
    const [image] = JSON.parse(await docker(['image', 'inspect', c.Image], { capture: true }));
    return {
        image: c.Image,
        env: c.Config.Env ?? [],
        revision: image.Config.Labels?.['org.opencontainers.image.revision'],
    };
}

async function fetchSource(revision) {
    const cacheRoot = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ghost-activitypub-importer');
    const dir = join(cacheRoot, revision);
    if (existsSync(join(dir, 'tsconfig.json'))) return dir;

    console.log(`Downloading TryGhost/ActivityPub ${revision.slice(0, 8)}…`);
    mkdirSync(cacheRoot, { recursive: true });
    const res = await fetch(`https://codeload.github.com/TryGhost/ActivityPub/tar.gz/${revision}`);
    if (!res.ok) fail(`could not download TryGhost/ActivityPub ${revision}: HTTP ${res.status}`);
    const partial = mkdtempSync(join(cacheRoot, '.download-'));
    await run('tar', ['-xzf', '-', '-C', partial, '--strip-components=1'], {
        stdin: Readable.fromWeb(res.body),
    });
    renameSync(partial, dir);
    return dir;
}

async function bundle(source, outDir) {
    // Newer server revisions may drop the polyfill; import it first where it
    // exists, the same way src/app.ts does
    const polyfill = existsSync(join(source, 'src', 'temporal-polyfill.ts'));
    const entry = join(outDir, 'entry.ts');
    writeFileSync(
        entry,
        `${polyfill ? "import '@/temporal-polyfill';\n" : ''}import ${JSON.stringify(IMPORTER)};\n`,
    );
    await esbuild.build({
        entryPoints: [entry],
        outfile: join(outDir, 'importer.js'),
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        tsconfig: join(source, 'tsconfig.json'),
        logLevel: 'warning',
    });
}

async function main() {
    const { values: opts, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            container: { type: 'string' },
            export: { type: 'string' },
            commit: { type: 'boolean', default: false },
            revision: { type: 'string' },
            source: { type: 'string' },
            'sign-host': { type: 'string' },
            'ghost-url': { type: 'string' },
            'content-api-key': { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
    });
    const [command] = positionals;
    if (opts.help || !command) {
        console.log(USAGE);
        return;
    }
    const spec = COMMANDS[command];
    if (!spec) fail(`unknown command ${command}\n\n${USAGE}`);
    for (const flag of ['container', 'export', ...spec.required]) {
        if (!opts[flag]) fail(`${command} needs --${flag}`);
    }
    if (opts.commit && !spec.commit) fail(`${command} has no --commit`);
    const exportDir = resolve(opts.export);
    if (!existsSync(join(exportDir, 'activitypub', 'actor.json'))) {
        fail(`${exportDir} is not a ghost-activitypub-exporter export (no activitypub/actor.json)`);
    }

    const server = await inspectContainer(opts.container);
    const revision = opts.revision ?? server.revision;
    if (!opts.source && !revision) {
        fail('the server image has no revision label; pass --revision <sha> or --source <dir>');
    }
    const source = opts.source ? resolve(opts.source) : await fetchSource(revision);

    const work = mkdtempSync(join(tmpdir(), 'ghost-activitypub-importer-'));
    let volume;
    try {
        await bundle(source, work);
        const envFile = join(work, 'server.env');
        writeFileSync(envFile, `${server.env.join('\n')}\n`, { mode: 0o600 });

        volume = (await docker(['volume', 'create'], { capture: true })).toString().trim();
        const inVolume = (script) => [
            'run', '--rm', '-i', '-v', `${volume}:/import`, '--entrypoint', 'sh', server.image, '-c', script,
        ];
        await pipe(
            ['tar', ['-cf', '-', '-C', exportDir, '.']],
            ['docker', inVolume('mkdir -p /import/export && tar -xf - -C /import/export')],
        );
        await pipe(
            ['tar', ['-cf', '-', '-C', work, 'importer.js']],
            ['docker', inVolume('mkdir -p /import/tool && tar -xf - -C /import/tool')],
        );

        console.log(
            `Running ${command} on ${opts.container} (TryGhost/ActivityPub ${(revision ?? 'local source').slice(0, 8)})${
                spec.commit && !opts.commit ? ', dry run' : ''
            }`,
        );
        let failed;
        try {
            await docker([
                'run', '--rm',
                '--network', `container:${opts.container}`,
                '--volumes-from', opts.container,
                '-v', `${volume}:/import`,
                '--env-file', envFile,
                '--entrypoint', 'sh',
                server.image,
                '-c', 'cp /import/tool/importer.js ./ghost-activitypub-importer.js && exec node ghost-activitypub-importer.js "$@"',
                'importer', command, '/import/export',
                ...spec.args(opts),
                ...(opts.commit ? ['--commit'] : []),
            ]);
        } catch (err) {
            failed = err;
        }

        // Files the importer wrote go back into the export, even after a
        // failure, so a rerun starts from them
        const files = OUTPUTS.join(' ');
        const archive = await docker(
            inVolume(
                `cd /import/export && set -- && for f in ${files}; do [ -f "$f" ] && set -- "$@" "$f"; done; [ $# -eq 0 ] || tar -cf - "$@"`,
            ),
            { capture: true },
        );
        if (archive.length > 0) {
            await run('tar', ['-xf', '-', '-C', exportDir], { stdin: Readable.from([archive]) });
        }
        if (failed) throw new Error(`${command} failed`);
    } finally {
        if (volume) await docker(['volume', 'rm', '-f', volume], { capture: true }).catch(() => {});
        rmSync(work, { recursive: true, force: true });
    }
}

main().catch((err) => fail(err.message));
