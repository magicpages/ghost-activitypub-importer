# ghost-activitypub-importer

Moves a Ghost ActivityPub account from Ghost's hosted service (ap.ghost.org, used by Ghost(Pro) and by self-hosted Ghost sites) to your own [TryGhost/ActivityPub](https://github.com/TryGhost/ActivityPub) server. It imports an export made with [ghost-activitypub-exporter](https://github.com/cathysarisky/ghost-activitypub-exporter). The account keeps its address, so followers don't have to follow it again.

```bash
npx github:magicpages/ghost-activitypub-importer cutover --container activitypub --export ./export
```

## How it works

On the fediverse, an account is its actor URL, for example `https://www.example.com/.ghost/activitypub/users/index`. Followers' servers store that URL. The URL is on the site's own domain, so whichever ActivityPub server answers for that domain answers for the account.

The importer doesn't use an ActivityPub `Move`. It recreates the account on your server under the same URL, then the site's DNS moves. The private key can't come along, because it stays with ap.ghost.org. The account gets a new key pair, and followers' servers pick up the new public key the next time they fetch the profile.

Mastodon servers send their users' follows again when they see the new key. Your server accepts them, and each one shows up as a follow notification.

## Requirements

- Your own TryGhost/ActivityPub server, running in Docker, and access to its Docker host. Tested against revision [`8e262525`](https://github.com/TryGhost/ActivityPub/commit/8e262525d5e876ea3049b5adf33257ca3b94ea54) (2 November 2026).
- Node.js 20 or newer and the Docker CLI, on the server or on your own machine.
- The export from ghost-activitypub-exporter, unpacked.
- The site on its custom domain, moving with the same site URL, including `www` or no `www`. A different domain is a different account, and a site on a `ghost.io` address can't move this way.
- The site's posts already moved to the new Ghost install, with the same slugs.
- Local storage on the ActivityPub server (`LOCAL_STORAGE_PATH` and `LOCAL_STORAGE_HOSTING_URL`) for the `media` step.

## What it does to your server

The importer uses your server's own code to fetch accounts and posts, so it has to match the version you run. Each command:

1. reads the container's image, environment and source revision (the image's `org.opencontainers.image.revision` label)
2. downloads TryGhost/ActivityPub at that revision once, into `~/.cache/ghost-activitypub-importer`, and builds the importer against it
3. runs the importer in a one-off container from the same image, with the server's environment, network and volumes

The running server container isn't changed. The export goes into a temporary Docker volume that's removed afterwards. Files the importer writes, `handles.json` and `mappings.json`, end up in your export directory.

To run it from your own machine against a server elsewhere, point the Docker CLI at it:

```bash
export DOCKER_HOST=ssh://root@your-server
```

## Commands

Every command takes `--container <name>` (your ActivityPub server container) and `--export <dir>`. `cutover`, `media` and `objects` only report what they would do, unless you add `--commit`.

### `prepare --sign-host <host>`

```bash
npx github:magicpages/ghost-activitypub-importer prepare --container activitypub --export ./export \
  --sign-host www.a-site-on-your-server.com
```

Fetches the account itself, and every account and post the export refers to that your database doesn't have yet. Requests are signed as the account of `--sign-host`, any site on your server, so servers that require signed fetches answer too. Writes `handles.json`.

It only adds data. Run it while ap.ghost.org still serves the account, because the account can't be fetched once it's gone. Accounts and posts that no longer exist are logged and skipped.

### `mappings --ghost-url <url> --content-api-key <key>`

```bash
npx github:magicpages/ghost-activitypub-importer mappings --container activitypub --export ./export \
  --ghost-url https://www.example.com --content-api-key <key>
```

Reads the new Ghost site's UUID and posts, and matches the account's articles to the posts by slug. Writes `mappings.json`. With it, editing or deleting a post in Ghost updates the article followers saw.

Run it against the new Ghost install. Unmatched articles are logged. They still work as ActivityPub posts, but changes in Ghost won't reach them.

### `cutover [--commit]`

Does the move, in one database transaction:

- creates the site row for the account's domain, with the Ghost site's UUID
- turns the account into a local one, with a new key pair and the profile from the export
- restores follows, likes, reposts, outbox, feed and notifications (marked as read)
- links articles to Ghost posts from `mappings.json`
- stores the outbox's ActivityPub objects, so the account's posts resolve
- restores the Bluesky handle

Running it again adds nothing. Without `--commit` it rolls back and prints the counts.

### `media [--commit]`

Copies the exported images into the server's local storage and points the account's posts at the new URLs.

### `objects [--commit]`

Stores the ActivityPub object for every note of the account that's in your database without one. Your server serves its own posts only from stored objects, so without this, those notes return 404 and can't be liked or replied to.

These are posts the export's outbox didn't contain: replies, and anything posted between the export and the switch.

## Switching over

1. Run `prepare` and `mappings`, then `cutover` without `--commit`, and read the counts.
2. Run `cutover --commit` and `media --commit`. Nothing changes publicly yet, because the domain still points at the old host.
3. Turn off Network on the old Ghost site. ap.ghost.org stops serving the account within about a minute.
4. Point the domain at the new host, with the site URL exactly as it was.
5. Run `objects --commit`, then check the profile, the followers and following counts, and a few posts.

Accounts in the export that no longer exist are skipped, so the follower count can drop.

## License

MIT
