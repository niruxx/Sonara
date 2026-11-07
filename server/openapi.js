// OpenAPI 3.1 description of Sonara's own JSON API, served at /api/openapi.json.
// (Client apps can also use the Subsonic / OpenSubsonic API at /rest, documented by that project.)
//
// Every route is one line below. `node scripts/list-routes.js --check` fails when a route in the
// code isn't listed here (or the other way round), so the description can't silently go stale.

import { baseUrl } from './oidc.js';
import fs from 'node:fs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// d(route, tag, summary, opts)
//   opts.query: 'name name:a|b|c …'  (enum values after a colon)
//   opts.body:  short description of the JSON body (or 'binary' / 'text' / 'form')
//   opts.auth:  'none' | 'admin' (default: signed in)
//   opts.res:   response schema name, 'binary' for media, 'events' for server-sent events
//   opts.desc:  longer description
const routes = [];
const d = (route, tag, summary, opts = {}) => routes.push({ route, tag, summary, ...opts });

const PAGE = 'limit offset';
const LIB = 'genre yearFrom yearTo type:album|ep|single|compilation|live|soundtrack|remix|other';

// ── System
d('GET /api/health', 'System', 'Health check (database, scanner)', { auth: 'none' });
d('GET /api/version', 'System', 'Server name and version', { auth: 'none' });
d('GET /api/openapi.json', 'System', 'This description', { auth: 'none' });

// ── Sign-in
d('GET /api/auth/status', 'Auth', 'Who is signed in, and how people can sign in', { auth: 'none' });
d('POST /api/auth/setup', 'Auth', 'Create the first admin account (only while there are no users)', { auth: 'none', body: '{ username, password }' });
d('POST /api/auth/login', 'Auth', 'Sign in with a password (sets the session cookie)', { auth: 'none', body: '{ username, password, code? (two-factor) }', desc: 'Answers 401 with { needCode: true } when a two-factor code is needed.' });
d('POST /api/auth/logout', 'Auth', 'Sign out of this session', { auth: 'none' });
d('GET /api/auth/oidc/start', 'Auth', 'Start single sign-on (redirect)', { auth: 'none' });
d('GET /api/auth/oidc/callback', 'Auth', 'Single sign-on return address (redirect)', { auth: 'none' });

// ── Your account
d('PUT /api/me/password', 'Me', 'Change your password (signs out other sessions)', { body: '{ current, password }' });
d('POST /api/me/2fa/setup', 'Me', 'Start setting up two-factor sign-in (returns a secret and otpauth URI)');
d('POST /api/me/2fa/enable', 'Me', 'Turn on two-factor sign-in', { body: '{ code }' });
d('POST /api/me/2fa/disable', 'Me', 'Turn off two-factor sign-in', { body: '{ code }' });
d('GET /api/me/app-passwords', 'Me', 'Your app passwords (for client apps; values are never shown again)');
d('POST /api/me/app-passwords', 'Me', 'Create an app password', { body: '{ name }', desc: 'The response holds the password itself, once. Use it in Subsonic apps instead of your account password.' });
d('DELETE /api/me/app-passwords/:id', 'Me', 'Revoke an app password');
d('PUT /api/me/activity-sharing', 'Me', 'Show (or hide) what you play to other people on this server', { body: '{ on }' });
d('GET /api/me/player', 'Me', 'Your saved player state (queue, position, volume…)');
d('PUT /api/me/player', 'Me', 'Save your player state, to resume on another device', { body: '{ queue: [trackId], original, index, time, shuffle, repeat, volume, muted, rate, device }' });
d('GET /api/me/services', 'Me', 'Scrobbling connections (Last.fm, ListenBrainz)');
d('PUT /api/me/services/listenbrainz', 'Me', 'Connect ListenBrainz', { body: '{ token }' });
d('PUT /api/me/services/:service/enabled', 'Me', 'Pause or resume scrobbling to a service', { body: '{ enabled }' });
d('DELETE /api/me/services/:service', 'Me', 'Disconnect a scrobbling service');
d('GET /api/lastfm/connect', 'Me', 'Start connecting Last.fm (redirect)');
d('GET /api/lastfm/callback', 'Me', 'Last.fm return address (redirect)');
d('GET /api/me/history', 'Me', 'Status of listening-history imports');
d('DELETE /api/me/history', 'Me', 'Undo imported listening history');
d('POST /api/me/history/lastfm', 'Me', 'Import your Last.fm history', { body: '{ username }' });
d('POST /api/me/history/listenbrainz', 'Me', 'Import your ListenBrainz history', { body: '{ username }' });
d('POST /api/me/history/listens', 'Me', 'Import a batch of listens (e.g. from a Spotify export)', { body: '{ listens: [{ artist, title, album?, at }] }' });
d('GET /api/me/webhooks', 'Me', 'Your webhooks');
d('POST /api/me/webhooks', 'Me', 'Add a webhook (signed with X-Sonara-Signature)', { body: '{ url, events: [track.started|playback.paused|playback.resumed] }' });
d('DELETE /api/me/webhooks/:id', 'Me', 'Delete a webhook');
d('POST /api/me/webhooks/:id/test', 'Me', 'Send a test delivery');

// ── Library
d('GET /api/stats', 'Library', 'Library totals and your play count');
d('GET /api/home', 'Library', 'Home page sections (recently played, added, top artists…)');
d('GET /api/albums', 'Library', 'Albums', { query: `${PAGE} sort:name|artist|year|oldest|recent|played|lastPlayed|rating|random ${LIB}`, res: 'Album[]' });
d('GET /api/albums/facets', 'Library', 'Years and release types present, for filters');
d('GET /api/albums/:id', 'Library', 'An album with its songs', { res: 'AlbumDetail' });
d('GET /api/artists', 'Library', 'Album artists', { query: PAGE, res: 'Artist[]' });
d('GET /api/artists/:id', 'Library', 'An artist: releases by type, appearances and popular songs');
d('GET /api/artists/:id/tracks', 'Library', 'Every song an artist is credited on', { res: 'Track[]' });
d('GET /api/artists/:id/info', 'Library', 'Biography and photo (online, when turned on)');
d('GET /api/artists/:id/discography', 'Library', 'Albums by the artist that aren’t in the library (MusicBrainz, when turned on)');
d('GET /api/discography/new', 'Library', 'New releases from artists in the library');
d('GET /api/tracks', 'Library', 'Songs', { query: `${PAGE} sort:title|artist|album|recent|year|duration|played|lastPlayed|rating ${LIB} minRating favorites`, res: 'Track[]' });
d('GET /api/tracks/count', 'Library', 'Number and total length of songs for the same filters', { query: `${LIB} minRating favorites` });
d('POST /api/tracks/lookup', 'Library', 'Songs by id, in the order given (null for missing ones)', { body: '{ ids: [trackId] }', res: 'Track[]' });
d('GET /api/tracks/random', 'Library', 'Random songs', { query: 'limit', res: 'Track[]' });
d('GET /api/tracks/:id', 'Library', 'One song with all its details', { res: 'Track' });
d('GET /api/genres', 'Library', 'Genres with song and album counts');
d('GET /api/search', 'Library', 'Search songs, albums and artists', { query: 'q' });

// ── Sync
d('GET /api/library/changes', 'Sync', 'What changed since your last sync', {
  query: 'since cursor limit',
  desc: 'For apps that keep their own copy of the library. Pass the previous answer’s `now` as `since` (0 or nothing for everything). '
    + 'Returns songs added or changed since then, ids of songs removed, and your favorites. While `more` is true, call again with `cursor=next` (same `since`). '
    + 'When `reset` is true, the last sync is too old: replace everything you have. Song ids are stable: re-tagging, rescans and moving or renaming files keep them.',
});

// ── Songs: playback, ratings, lyrics, analysis
d('GET /api/stream/:id', 'Media', 'Stream a song (transcoded when needed)', { query: 'format:auto|opus|mp3|aac|flac|raw bitrate codec:opus|mp3|aac wait', res: 'binary', desc: 'Supports byte ranges. Transcoded streams carry a strong ETag (the same for the same source and settings), so offline copies can be revalidated with If-None-Match.' });
d('GET /api/download/track/:id', 'Media', 'Download a song', { query: 'format bitrate', res: 'binary' });
d('GET /api/download/album/:id', 'Media', 'Download an album as a .zip', { query: 'format bitrate', res: 'binary' });
d('GET /api/download/playlist/:id', 'Media', 'Download a playlist as a .zip', { query: 'format bitrate', res: 'binary' });
d('GET /api/cover/:file', 'Media', 'Cover art (file names come from the `cover` fields)', { res: 'binary' });
d('POST /api/tracks/:id/play', 'Media', 'Count a play');
d('POST /api/tracks/:id/nowplaying', 'Media', 'Tell scrobbling services what’s playing');
d('POST /api/tracks/:id/scrobble', 'Media', 'Scrobble a finished song', { body: '{ startedAt? }' });
d('PUT /api/ratings/:id', 'Media', 'Rate a song (0 clears)', { body: '{ rating: 0-5 }' });
d('GET /api/tracks/:id/lyrics', 'Media', 'Lyrics (synced when available)', { query: 'refresh' });
d('PUT /api/tracks/:id/lyrics', 'Media', 'Set a song’s lyrics', { auth: 'admin', body: '{ text }' });
d('GET /api/tracks/:id/analysis', 'Media', 'Waveform, loudness, tempo and key');
d('PUT /api/tracks/:id/analysis', 'Media', 'Store an analysis made in the browser', { body: 'analysis results' });
d('GET /api/analysis/pending', 'Media', 'Songs the browser could analyse');
d('GET /api/analysis/status', 'Media', 'Background analysis progress');

// ── Discovery
d('GET /api/tracks/:id/similar', 'Discovery', 'Songs that sound alike (needs analysis)', { query: 'limit', res: 'Track[]' });
d('GET /api/mixes', 'Discovery', 'Mood and time-of-day mixes');
d('GET /api/mixes/:id', 'Discovery', 'The songs of a mix', { query: 'limit', res: 'Track[]' });
d('GET /api/radio', 'Discovery', 'A radio station from a seed', { query: 'seed limit exclude', desc: 'seed: track:<id>, album:<id>, artist:<id>, genre:<name> or sound:<trackId>.', res: 'Track[]' });
d('GET /api/stats/listening', 'Discovery', 'Your listening statistics', { query: 'period:week|month|year|all|<year>' });
d('GET /api/activity', 'Discovery', 'What friends who share their activity are playing');

// ── Favorites
d('GET /api/favorites', 'Favorites', 'Your favorite songs', { res: 'Track[]' });
d('PUT /api/favorites/:id', 'Favorites', 'Add a song to your favorites');
d('DELETE /api/favorites/:id', 'Favorites', 'Remove a song from your favorites');
d('GET /api/bookmarks', 'Favorites', 'Your bookmarks in songs and episodes', { query: 'track episode' });
d('POST /api/bookmarks', 'Favorites', 'Add a bookmark', { body: '{ trackId | episodeId, position (seconds), label? }' });
d('PUT /api/bookmarks/:id', 'Favorites', 'Rename a bookmark', { body: '{ label }' });
d('DELETE /api/bookmarks/:id', 'Favorites', 'Delete a bookmark');

// ── Playlists
d('GET /api/playlists', 'Playlists', 'Your playlists and the ones shared with you');
d('POST /api/playlists', 'Playlists', 'Create a playlist', { body: '{ name, description?, trackIds? }' });
d('POST /api/playlists/import', 'Playlists', 'Import an .m3u, .m3u8, .xspf or CSV playlist', { query: 'name', body: 'text' });
d('GET /api/playlists/:id', 'Playlists', 'A playlist with its songs');
d('PUT /api/playlists/:id', 'Playlists', 'Rename, describe or change who can see it', { body: '{ name?, description?, visibility?: private|public|collaborative }' });
d('DELETE /api/playlists/:id', 'Playlists', 'Delete a playlist');
d('GET /api/playlists/:id/export', 'Playlists', 'Export as a playlist file', { query: 'format:m3u8|m3u|xspf', res: 'binary' });
d('POST /api/playlists/:id/tracks', 'Playlists', 'Add songs', { body: '{ trackIds }' });
d('DELETE /api/playlists/:id/tracks/:entryId', 'Playlists', 'Remove one entry');
d('PUT /api/playlists/:id/order', 'Playlists', 'Reorder', { body: '{ entryIds }' });
d('GET /api/smart-playlists', 'Playlists', 'Your smart playlists');
d('POST /api/smart-playlists', 'Playlists', 'Create a smart playlist', { body: '{ name, description?, rules, sort?, maxTracks? }' });
d('GET /api/smart-playlists/fields', 'Playlists', 'Fields, operators and sorts smart playlist rules can use');
d('POST /api/smart-playlists/preview', 'Playlists', 'How many songs some rules match, with a sample', { body: '{ rules, sort?, maxTracks? }' });
d('GET /api/smart-playlists/:id', 'Playlists', 'A smart playlist with its songs');
d('PUT /api/smart-playlists/:id', 'Playlists', 'Change a smart playlist', { body: '{ name, description?, rules, sort?, maxTracks? }' });
d('DELETE /api/smart-playlists/:id', 'Playlists', 'Delete a smart playlist');

// ── Podcasts
d('GET /api/podcasts', 'Podcasts', 'Your podcasts');
d('POST /api/podcasts', 'Podcasts', 'Subscribe by feed address', { body: '{ url }' });
d('GET /api/podcasts/search', 'Podcasts', 'Search the podcast directory (when turned on)', { query: 'q' });
d('GET /api/podcasts/opml', 'Podcasts', 'Export your subscriptions as OPML', { res: 'binary' });
d('POST /api/podcasts/opml', 'Podcasts', 'Import subscriptions from OPML', { body: '{ text }' });
d('GET /api/podcasts/episodes/latest', 'Podcasts', 'Newest episodes of your podcasts', { query: 'limit' });
d('GET /api/podcasts/episodes/continue', 'Podcasts', 'Episodes you started');
d('GET /api/podcasts/episodes/:id', 'Podcasts', 'One episode');
d('GET /api/podcasts/episodes/:id/stream', 'Podcasts', 'Play an episode', { res: 'binary' });
d('GET /api/podcasts/episodes/:id/chapters', 'Podcasts', 'Chapters (Podcasting 2.0 / Podlove)');
d('GET /api/podcasts/episodes/:id/transcript', 'Podcasts', 'Transcript cues');
d('PUT /api/podcasts/episodes/:id/progress', 'Podcasts', 'Save where you are in an episode', { body: '{ position, played? }' });
d('POST /api/podcasts/episodes/:id/download', 'Podcasts', 'Keep a copy on the server');
d('DELETE /api/podcasts/episodes/:id/download', 'Podcasts', 'Delete the server’s copy', { auth: 'admin' });
d('GET /api/podcasts/:id', 'Podcasts', 'A podcast with its episodes');
d('POST /api/podcasts/:id/subscribe', 'Podcasts', 'Subscribe');
d('DELETE /api/podcasts/:id', 'Podcasts', 'Unsubscribe');
d('POST /api/podcasts/:id/refresh', 'Podcasts', 'Check for new episodes now');
d('POST /api/podcasts/:id/played', 'Podcasts', 'Mark every episode played (or unplayed)', { body: '{ played }' });
d('PUT /api/podcasts/:id/settings', 'Podcasts', 'Automatic downloads for a podcast', { auth: 'admin', body: '{ autoDownload: 0-50 }' });

// ── Radio
d('GET /api/stations', 'Radio', 'Your internet radio stations');
d('POST /api/stations', 'Radio', 'Add a station', { body: '{ name, url, homepage?, image?, tags? }' });
d('GET /api/stations/search', 'Radio', 'Search radio-browser.info (when turned on)', { query: 'q tag country' });
d('PUT /api/stations/:id', 'Radio', 'Change a station', { body: '{ name?, url?, homepage?, image?, tags? }' });
d('DELETE /api/stations/:id', 'Radio', 'Delete a station');
d('GET /api/stations/:id/now', 'Radio', 'The title on air now');
d('GET /api/stations/:id/stream', 'Radio', 'Listen to a station', { res: 'binary' });

// ── Sharing
d('GET /api/shares', 'Sharing', 'Your public share links');
d('POST /api/shares', 'Sharing', 'Create a public link', { body: '{ kind: track|album|playlist, id, expiresInDays?, allowDownload?, description? }' });
d('PUT /api/shares/:id', 'Sharing', 'Change a share link', { body: '{ description?, expiresInDays?, allowDownload? }' });
d('DELETE /api/shares/:id', 'Sharing', 'Revoke a share link');
d('GET /api/public/shares/:id', 'Public', 'What a share link holds', { auth: 'none' });
d('GET /api/public/shares/:id/stream/:trackId', 'Public', 'Play a shared song', { auth: 'none', res: 'binary' });
d('GET /api/public/shares/:id/cover/:file', 'Public', 'Cover art of a share', { auth: 'none', res: 'binary' });
d('GET /api/public/shares/:id/download', 'Public', 'Download a share (when allowed)', { auth: 'none', res: 'binary' });
d('GET /api/public/stream/:id', 'Public', 'Signed stream address for speakers and casting', { auth: 'none', res: 'binary' });
d('GET /api/public/cover/:file', 'Public', 'Signed cover address for speakers and casting', { auth: 'none', res: 'binary' });

// ── Devices and listening parties
d('GET /api/connect/events', 'Devices', 'Live updates (server-sent events): devices, commands, parties', { res: 'events', query: 'device name' });
d('POST /api/connect/state', 'Devices', 'Report what this device is playing', { body: 'player state' });
d('POST /api/connect/command', 'Devices', 'Control another device', { body: '{ device, cmd, args? }' });
d('GET /api/connect/devices', 'Devices', 'Your other devices, speakers and casting targets', { query: 'device' });
d('POST /api/connect/cast-url', 'Devices', 'Signed address a Chromecast can play', { body: '{ id }' });
d('POST /api/party', 'Devices', 'Start a listening party');
d('GET /api/party/:id', 'Devices', 'A listening party');
d('POST /api/party/:id/join', 'Devices', 'Join a listening party');
d('POST /api/party/:id/leave', 'Devices', 'Leave (or, as the host, end) a listening party', { body: '{ device, end? }' });
d('POST /api/party/:id/requests', 'Devices', 'Request a song', { body: '{ trackId }' });
d('POST /api/party/:id/requests/:rid/vote', 'Devices', 'Vote for a request');
d('DELETE /api/party/:id/requests/:rid', 'Devices', 'Withdraw or decline a request');

// ── Administration
const A = (route, summary, opts = {}) => d(route, 'Admin', summary, { auth: 'admin', ...opts });
A('GET /api/admin/users', 'Everyone’s accounts');
A('POST /api/admin/users', 'Create an account', { body: '{ username, password, isAdmin? }' });
A('PUT /api/admin/users/:id', 'Change an account (admin, password, bitrate, permissions, folders, reset two-factor)', { body: '{ isAdmin?, password?, maxBitrate?, permissions?, libraryDirs?, resetTwoFactor? }' });
A('DELETE /api/admin/users/:id', 'Delete an account');
A('GET /api/admin/settings', 'Server settings');
A('PUT /api/admin/settings', 'Change server settings', { body: 'any settings from GET' });
A('GET /api/admin/browse', 'Browse the server’s folders', { query: 'path files:video|all' });
A('POST /api/admin/scan', 'Start a library scan', { body: '{ full? }' });
A('GET /api/admin/scan', 'Scan progress', { query: 'issues' });
A('GET /api/admin/scan/history', 'Past scans');
A('GET /api/admin/logs', 'Recent log lines', { query: 'level:warn|error q limit' });
A('GET /api/admin/backups', 'Database backups');
A('POST /api/admin/backups', 'Back up now');
A('GET /api/admin/backups/:name', 'Download a backup', { res: 'binary' });
A('DELETE /api/admin/backups/:name', 'Delete a backup');
A('POST /api/admin/backups/:name/restore', 'Restore a backup at the next restart');
A('DELETE /api/admin/restore', 'Cancel a pending restore');
A('POST /api/admin/restore/upload', 'Upload a backup to restore', { body: 'binary' });
A('POST /api/admin/restart', 'Restart Sonara');
A('GET /api/admin/reports/duplicates', 'Possible duplicate songs');
A('GET /api/admin/reports/missing', 'Songs with missing metadata');
A('GET /api/admin/shares', 'Everyone’s share links');
A('GET /api/admin/speakers', 'Server speaker and DLNA status');
A('POST /api/admin/speakers/discover', 'Look for DLNA speakers');
A('GET /api/admin/snapcast/rooms', 'Snapcast rooms');
A('GET /api/admin/tools', 'ffmpeg, yt-dlp and fpcalc availability');
A('POST /api/admin/tracks/tags', 'Edit tags of songs (writes the files)', { body: '{ ids, tags }' });
A('POST /api/admin/tracks/:id/identify', 'Identify a song by its sound (AcoustID)');
A('POST /api/admin/tracks/move', 'Move songs to another folder', { body: '{ ids, dir }' });
A('GET /api/admin/organize/templates', 'Folder layout templates');
A('POST /api/admin/organize', 'Rename and move files by their tags (or preview it)', { body: '{ scope, template, mode: move|copy, root, dryRun }' });
A('GET /api/admin/inbox', 'Inbox files, jobs and tools');
A('GET /api/admin/inbox/jobs', 'Download and conversion jobs');
A('DELETE /api/admin/inbox/jobs', 'Clear finished jobs');
A('POST /api/admin/inbox/jobs/:id/cancel', 'Cancel a job');
A('GET /api/admin/inbox/file/:name', 'Play or download an Inbox file', { res: 'binary' });
A('PUT /api/admin/inbox/tags/:name', 'Edit an Inbox file’s tags', { body: '{ tags }' });
A('PUT /api/admin/inbox/rename/:name', 'Rename an Inbox file', { body: '{ name }' });
A('DELETE /api/admin/inbox/:name', 'Delete an Inbox file');
A('POST /api/admin/inbox/download', 'Download with yt-dlp', { body: '{ url, format, playlist?, embedThumbnail? }' });
A('POST /api/admin/inbox/convert', 'Convert a video to audio', { body: '{ name | path, format, bitrate?, deleteSource? }' });
A('POST /api/admin/inbox/upload', 'Upload a file to the Inbox', { query: 'name', body: 'binary' });
A('POST /api/admin/inbox/import', 'File Inbox files into the library', { body: '{ names, template + root | dir, playlistId? }' });
A('POST /api/admin/albums/:id/cover', 'Upload an album cover', { body: 'binary' });
A('POST /api/admin/albums/:id/cover/from', 'Use a found cover', { body: '{ url | file }' });
A('GET /api/admin/albums/:id/cover/candidates', 'Cover candidates (folder, Cover Art Archive)');
A('DELETE /api/admin/albums/:id/cover', 'Go back to the album’s own cover');
A('GET /api/admin/covers', 'Missing-cover search progress');
A('POST /api/admin/covers', 'Look for missing covers', { body: '{ all? }' });
A('GET /api/admin/transcode', 'Transcoding cache size');
A('DELETE /api/admin/transcode', 'Empty the transcoding cache');

// ───────────────────────── Building the document ─────────────────────────

const TAG_DESC = {
  System: 'Health and version, no sign-in needed.',
  Auth: 'Sign-in. The web app uses a session cookie (sonara_session).',
  Me: 'Your own account, connections and app passwords.',
  Library: 'Browsing the music library.',
  Sync: 'Keeping an offline copy of the library up to date.',
  Media: 'Playing, downloading and annotating songs.',
  Discovery: 'Radio, mixes, similar songs and statistics.',
  Favorites: 'Favorites and bookmarks.',
  Playlists: 'Playlists and smart playlists.',
  Podcasts: 'Podcast subscriptions and episodes.',
  Radio: 'Internet radio stations.',
  Sharing: 'Public share links.',
  Public: 'What share links and casting devices use, without an account.',
  Devices: 'Controlling other devices, casting and listening parties.',
  Admin: 'Server administration (admins only).',
};

const TRACK = {
  type: 'object',
  properties: {
    id: { type: 'integer', description: 'Stable: kept across rescans, re-tagging and file moves' },
    title: { type: 'string' }, artist: { type: 'string' }, artistId: { type: 'string' }, album: { type: 'string' }, albumId: { type: 'string' },
    albumArtist: { type: 'string' }, albumArtistId: { type: 'string' }, artists: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } },
    trackNo: { type: ['integer', 'null'] }, discNo: { type: ['integer', 'null'] }, year: { type: ['integer', 'null'] }, genre: { type: ['string', 'null'] },
    duration: { type: 'number', description: 'Seconds' }, bitrate: { type: ['integer', 'null'] }, sampleRate: { type: ['integer', 'null'] }, codec: { type: ['string', 'null'] },
    lossless: { type: 'boolean' }, cover: { type: ['string', 'null'], description: 'File name for /api/cover/{file}' }, addedAt: { type: 'integer' },
    favorite: { type: 'boolean' }, rating: { type: 'integer', minimum: 0, maximum: 5 }, playCount: { type: 'integer' }, lastPlayed: { type: ['integer', 'null'] },
    bpm: { type: ['number', 'null'] }, musicalKey: { type: ['string', 'null'] }, camelot: { type: ['string', 'null'] }, energy: { type: ['number', 'null'] },
    rgTrackGain: { type: ['number', 'null'] }, rgAlbumGain: { type: ['number', 'null'] }, calcTrackGain: { type: ['number', 'null'] },
  },
};
const ALBUM = {
  type: 'object',
  properties: {
    id: { type: 'string' }, name: { type: 'string' }, artist: { type: 'string' }, artistId: { type: 'string' }, year: { type: ['integer', 'null'] },
    cover: { type: ['string', 'null'] }, trackCount: { type: 'integer' }, duration: { type: 'number' }, addedAt: { type: 'integer' },
    genre: { type: ['string', 'null'] }, releaseType: { type: ['string', 'null'] }, compilation: { type: 'integer' },
  },
};
const ARTIST = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, cover: { type: ['string', 'null'] }, albumCount: { type: 'integer' }, trackCount: { type: 'integer' } } };
const SCHEMAS = {
  Track: TRACK, Album: ALBUM, Artist: ARTIST,
  AlbumDetail: { allOf: [{ $ref: '#/components/schemas/Album' }, { type: 'object', properties: { tracks: { type: 'array', items: { $ref: '#/components/schemas/Track' } }, genres: { type: 'array', items: { type: 'string' } } } }] },
  Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
};

const schemaRef = (name) => (name.endsWith('[]')
  ? { type: 'array', items: { $ref: `#/components/schemas/${name.slice(0, -2)}` } }
  : { $ref: `#/components/schemas/${name}` });

function operation(r) {
  const [method, p] = r.route.split(' ');
  const parameters = [...p.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
  for (const qp of (r.query || '').split(/\s+/).filter(Boolean)) {
    const [name, values] = qp.split(':');
    parameters.push({ name, in: 'query', required: false, schema: values ? { type: 'string', enum: values.split('|') } : { type: 'string' } });
  }
  const op = {
    tags: [r.tag], summary: r.summary, operationId: `${method.toLowerCase()}${p.replace(/^\/api/, '').replace(/[:/{}.-](\w)?/g, (_, c) => (c ? c.toUpperCase() : ''))}`,
    ...(r.desc ? { description: r.desc } : {}),
    ...(parameters.length ? { parameters } : {}),
  };
  if (r.body) {
    const content = r.body === 'binary' ? { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
      : r.body === 'text' ? { 'text/plain': { schema: { type: 'string' } } }
        : { 'application/json': { schema: { type: 'object', description: r.body } } };
    op.requestBody = { required: true, content };
  }
  const ok = r.res === 'binary' ? { description: 'File or stream', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }
    : r.res === 'events' ? { description: 'Server-sent events', content: { 'text/event-stream': { schema: { type: 'string' } } } }
      : { description: 'OK', content: { 'application/json': { schema: r.res ? schemaRef(r.res) : { type: 'object' } } } };
  op.responses = { 200: ok, default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } };
  if (r.auth === 'none') op.security = [];
  else if (r.auth === 'admin') op.description = `${op.description ? `${op.description}\n\n` : ''}Admins only.`;
  return [method.toLowerCase(), p.replace(/:(\w+)/g, '{$1}'), op];
}

/** "METHOD /api/path" for every documented route (checked against the code by scripts/list-routes.js). */
export const documentedRoutes = () => routes.map((r) => r.route);

export function openapiSpec(req) {
  const paths = {};
  for (const r of routes) {
    const [method, p, op] = operation(r);
    (paths[p] ||= {})[method] = op;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Sonara API',
      version: VERSION,
      description: 'The JSON API behind Sonara’s web app. Sign in with POST /api/auth/login (session cookie); '
        + 'every route needs a signed-in user unless marked otherwise. Errors come back as { "error": "…" } with a 4xx/5xx status. '
        + 'Client apps can also use the Subsonic / OpenSubsonic API at /rest (see https://opensubsonic.netlify.app), signing in with an app password.',
      license: { name: 'MIT' },
    },
    servers: [{ url: req ? baseUrl(req) : '/' }],
    tags: Object.entries(TAG_DESC).map(([name, description]) => ({ name, description })),
    security: [{ session: [] }],
    components: {
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'sonara_session', description: 'Set by POST /api/auth/login' } },
      schemas: SCHEMAS,
    },
    paths,
  };
}
