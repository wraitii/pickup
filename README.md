# Pickup

[Play Pickup](https://wraitii.github.io/pickup/)

A browser DAW for jamming with an AI "band" on [Strudel](https://strudel.cc) code.
The song is a set of clip files (`<section>/<variant>.js`) placed on a timeline
(`song.json`). The band reads and edits those files, and it can play or listen
to what it made.

```sh
npm install
npm run dev
```

`npm run build` type-checks and builds a static site into `dist/` (relative
paths, so it works from any subfolder). Pushing to `main` deploys it to GitHub
Pages via `.github/workflows/pages.yml`. In the repo settings, set Pages'
source to "GitHub Actions".

Songs are kept in this browser's library (**songs** in the top bar). From there
you can open a song, start a new one, or export and import `.pickup.json` files.
An export includes the song's clip files and any mic takes it plays
(`rec_*`). Built-in sounds are referenced by name and load from GitHub, so
they aren't included in the file.

## Band models

Pick a provider in the top bar's settings. OpenRouter shows the API key, model and reasoning options; Local shows relay setup instructions.

- **OpenRouter models:** add your OpenRouter API key in settings. The page then
  calls the model directly.
- **Local:** for driving the band with a subscription (e.g. Claude Code)
  instead of API credits. No API key. Each band turn goes to a relay on your machine, and an
  outside driver (for example Claude Code in a terminal) plays the band.

## Local usage

1. Start the relay and keep it running (Node 18+, no dependencies):

   ```sh
   node scripts/band.mjs serve            # listens on http://localhost:7878
   ```

   This also works from the hosted page. Some browsers ask for permission
   before an https page can reach `http://localhost`, and some block it
   (Safari does). If yours blocks it, run `npm run dev` and use that instead.

   Set `PICKUP_BAND_PORT` to use another port. The app itself expects port 7878
   (`LOCAL_RELAY` in `src/agent/local.ts`).

2. In the app, pick **Local** as the provider in settings and send a message.

3. Drive the band from a terminal:

   ```sh
   node scripts/band.mjs wait                 # block until the user sends a message; print it
   node scripts/band.mjs system               # print the band's system prompt
   node scripts/band.mjs tool ls              # call a band tool; args as JSON or on stdin
   node scripts/band.mjs tool read '{"path":"chorus/main.js"}'
   node scripts/band.mjs say "Done, have a listen"   # reply to the user; ends the turn
   ```

   A turn is any number of `tool` calls followed by one `say`. The page stays
   in "band is working" until `say`. `tool` fails if no turn is open (send a
   message from the app first).

### Tools

| tool          | args                        | what it does                                           |
| ------------- | --------------------------- | ------------------------------------------------------ |
| `ls`          | none                        | song and clip files, with bar counts and notes         |
| `read`        | `path`                      | a file's content                                       |
| `write`       | `path`, `content`           | create or overwrite a file (validated first)           |
| `edit`        | `path`, `edits[{oldText, newText}]` | exact-text replacements in a file              |
| `mv`          | `from`, `to`                | rename a clip; song.json and `from` links follow       |
| `rm`          | `path`                      | delete a clip (refused while it's placed)              |
| `play`        | `target`                    | what the user hears: a clip ref, `"song"`, or `"9-16"` |
| `listen`      | `target`, optional `bars`   | offline render: per-bar level table plus spectrogram   |
| `list_sounds` | optional `query`            | search sample and synth names                          |

`listen` saves its spectrogram to a temp PNG and prints the path.

Pass long `write` content on stdin to avoid shell quoting:

```sh
node -e 'process.stdout.write(JSON.stringify({path:"chorus/main.js",content:require("fs").readFileSync("chorus.js","utf8")}))' \
  | node scripts/band.mjs tool write
```

### Driving from Claude Code

Tell Claude Code the relay is up and to play the band via `scripts/band.mjs`.
To keep it listening between messages, have it run `wait` as a background
command after every `say`. That way each new app message wakes it up without
you prompting it in the terminal:

```sh
until out=$(node scripts/band.mjs wait 2>&1) && [ -n "$out" ]; do :; done; echo "$out"
```

Each message the driver receives starts with context from the app: a
`<user-changes>` diff of your hand edits since the band last looked, and a
`<transport>` line saying what's playing.

## License

Pickup is free software under the [GNU AGPL v3.0](LICENSE) or later, like
[Strudel](https://strudel.cc), which it builds on. If you host a modified
version, you have to offer its source to your users.
