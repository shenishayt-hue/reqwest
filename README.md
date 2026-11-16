# SHAGGY XMD v5

- `/`      Home: live wallpaper, live stats chart, free pairing
- `/pro`   Pro pair page: WhatsApp number + payment slip, slip goes to owner automatically
- Slips are saved in `./slips` and re-sent every 45s if no bot was connected at upload time.

## .env
- `SLIP_RECEIVERS=94713836073,94784224161`  (numbers that receive slips; defaults to OWNER_NUMBERS)
- `PM2_NAME=shaggy-xmd`
- `FFMPEG_PATH=/path/to/ffmpeg` (optional, for .csong visualizer)

## v5 branding
- `LOGO_URL` (pair.js config) = logo used on menu, alive and on every text reply (small logo card).
- `brandcard.js` adds the logo card to text replies. Turn off with `.env` `LOGO_CARD=false`.

## Dashboard (`/panel`)
- Login = the bot number + the pairing code used when the bot was connected (hashed, never stored in plain text).
  Bots connected before this update can log in with the Access Key from the "Bot Activated" message.
- Editable: bot name, bot footer, movie footer, movie caption, bot image, always online / auto view / auto like / anti delete.
- Saving writes to MongoDB and pushes the new config straight into the running bot, so it applies immediately.
- Optional `.env`: `PANEL_SECRET=<long random text>` (signs login tokens; otherwise derived from MONGO_URI).

## 🎬 Request Bot (v5.1)
Owner commands (in the bot inbox or any chat):
- `.reqbot on` / `.reqbot off` / `.reqbot status`  (on = warns until both groups are set)
- `.setreq <group link>`  request group - anyone in it can type a movie / cartoon / anime name
- `.setmv <group link>`   movie group - the post + the video file is sent here
- `.reqset footer|caption|limit|warn|limitmsg|donemsg <value>`, `.reqset reset`
- `.reqbot inbox on|off`, `.reqbot allow <number>`, `.reqbot unallow <number>`

How it works: name in request group -> list (CineSubz + DinkaMovies + SinhalaCartoons + AnimeHeaven) ->
member replies with the number (cartoon / anime: then the episode number) -> post + video go to the movie group ->
Sinhala "done" message + poster in the request group. Default 3 films per person per day (Sri Lanka time).
A failed download is refunded. Inbox: 1st message = warning, a repeat (after 60s) = removed from both groups + blocked.
Everything is editable on the web dashboard (`/panel` -> "Request bot" card). Code: `reqbot.js`.

Env: `REQBOT_MAX_JOBS=2` (parallel downloads for the whole process).

## Fixes in this version
- Only `messages[0]` of a batch was handled -> the rest were lost. Now every message is handled (messages older than 2 min are skipped so an offline backlog can't replay old commands).
- Leaks: `noticeLast` never pruned, `voteInviteCache` / `votePollCache` unbounded, old socket listeners kept after reconnect,
  intervals / streams not cleared on logout (401) or when reconnects are exhausted, `rawCache` / `messageCache` / `pendingPairTier` had no TTL.
  A 10-minute sweeper now prunes them and logs `[mem] rss ... heap ...` so you can watch memory.
