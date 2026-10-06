'use strict';
// Run: node --test tests/b-reliability.test.cjs
// Synthetic metadata only; no network, real torrents, or media playback.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'b.js'), 'utf8');

function bus() {
    const handlers = new Map();
    return {
        follow(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
        remove(name, fn) { handlers.get(name)?.delete(fn); },
        send(name, event = {}) { for (const fn of [...(handlers.get(name) || [])]) fn(event); },
        count(name) { return handlers.get(name)?.size || 0; }
    };
}
function fixture() {
    const storage = { bq_warm: false, bq_voice: 'any', bq_hdr: 'ignore', bq_res: 'any' };
    const params = [], notices = [], plays = [], requests = [], timers = new Map();
    let clock = 0, nextTimer = 0, selection, playlist, currentPlay;
    const playerEvents = bus(), videoEvents = bus();
    const window = { screen: { width: 1920, height: 1080 }, navigator: {} };
    const context = vm.createContext({
        window, console, btoa: value => Buffer.from(value, 'binary').toString('base64'), Date: { now: () => clock },
        document: { createElement: () => ({ canPlayType: () => '' }) },
        setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { at: clock + delay, fn }); return id; },
        clearTimeout: id => timers.delete(id),
        XMLHttpRequest: function () { throw new Error('Network is forbidden in tests'); },
        Lampa: {
            Storage: { get: (key, fallback) => key in storage ? storage[key] : fallback, set: (key, value) => { storage[key] = value; } },
            Listener: { follow() {} },
            SettingsApi: { addComponent() {}, removeParams() { params.length = 0; }, addParam: value => params.push(value) },
            Noty: { show: message => notices.push(message) },
            Select: { show: value => { selection = value; } },
            Controller: { toggle() {} },
            Timeline: { view: hash => ({hash, time: 0, percent: 0}) },
            Player: { listener: playerEvents,
                play(value) { playerEvents.send('create', {data: value}); currentPlay = value; plays.push(value); playerEvents.send('ready', value); },
                playdata: () => currentPlay,
                playlist(value) { playlist = value; },
                close() { playerEvents.send('destroy'); currentPlay = null; }
            },
            PlayerVideo: { listener: videoEvents },
            Torserver: { url: () => 'http://server.invalid' },
            Api: { img: value => value }
        }
    });
    const exposure = `window.__test = {
        seasonsOfText, extractSeasons, filterBySeason, filesForSeason, isSeriesCard,
        releaseLanguages, scoreRelease, sizeLimit, hdrMode, codecPreference, addSettings,
        playInTorrserve, waitFiles, warmUp, findBest, pick, episodeOf, contAll, contGet, contSave, resumeSaved,
        request: tsApi, parser: search, checkServerConnection, browserProfile, tvMode, voiceMode, mediaText,
        report: function () { return lastReport; },
        state: function (series, season, max) { curIsSeries = series; curSeason = season; curMaxSeason = max || 0; },
        cancel: beginOperation,
        hooks: function (api, warm, parser) {
            if (api) tsApi = api;
            if (warm) warmUp = warm;
            if (parser) search = parser;
        }
    };`;
    vm.runInContext(source.replace('    if (window.appready) start();', exposure + '\n    if (window.appready) start();'), context);
    const api = window.__test;
    api.hooks((body, done, fail) => requests.push({ body, done, fail }));
    return { api, window, context, storage, params, notices, plays, requests,
        selection: () => selection, playlist: () => playlist, playerEvents, videoEvents,
        tick(ms) {
            const end = clock + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]); clock = due[1].at; due[1].fn();
            }
            clock = end;
        }
    };
}
const plain = value => JSON.parse(JSON.stringify(value));

for (const [title, seasons] of [
    ['Example S01E03', [1]], ['Example [01x01–09 из 10]', [1]],
    ['Example S01-S03', [1, 2, 3]], ['Example 1-3 сезони', [1, 2, 3]],
    ['Example сезоны: 2—4', [2, 3, 4]], ['Example Season_04', [4]],
    ['Example 2-й сезон', [2]], ['Example S01E01-E09', [1]],
    ['Example 1920x1080 / Серии 1-24', []], ['Example 2022-2024', []]
]) test('season metadata: ' + title, () => assert.deepEqual(plain(fixture().api.seasonsOfText(title)), seasons));

for (const [card, expected] of [
    [{ title: 'Example', name: 'Example', number_of_seasons: 4 }, true],
    [{ title: 'Example', media_type: 'tv' }, true],
    [{ title: 'Example', original_name: 'Example' }, true],
    [{ title: 'Example', seasons: [{ season_number: 1 }] }, true],
    [{ title: 'Example', media_type: 'movie', name: 'Example' }, false],
    [{ title: 'Example', release_date: '2020-01-01' }, false]
]) test('card classification: ' + JSON.stringify(card), () => assert.equal(fixture().api.isSeriesCard(card), expected));

for (const [title, ukr, rus] of [
    ['Example Original + Rus Sub', false, false],
    ['Example RUS + ENG / Subtitles: UKR', false, true],
    ['Example UKR / Sub: RUS, ENG', true, false],
    ['Example Sub RUS', false, false],
    ['Example Original + Русские субтитры', false, false],
    ['Example Ukrainian + Russian audio', true, true],
    ['Example Український дубляж', true, false],
    ['Example Русский дубляж', false, true],
    ['Example HDRip', false, false]
]) test('audio metadata: ' + title, () => assert.deepEqual(plain(fixture().api.releaseLanguages(title)), { ukr, rus }));

test('explicit audio metadata is read; subtitle metadata is excluded', () => {
    const f = fixture();
    assert.deepEqual(plain(f.api.releaseLanguages({ Title: 'Example', audio_tracks: [{ language: 'rus' }], subtitles: ['ukr'] })), { ukr: false, rus: true });
});
test('season files use nearest marker, not collection directory', () => {
    const f = fixture();
    const result = f.api.filesForSeason([{ path: 'Example S01-S04/S02/Example.S02E03.mp4' }], 1);
    assert.deepEqual(plain(result), { files: [], wrong: [2] });
});
test('season filtering retains packs and x notation, excludes wrong season', () => {
    const f = fixture(); f.api.state(true, 2, 4);
    const list = ['Example 02x01', 'Example S01-S03', 'Example S04'].map(Title => ({ Title }));
    assert.equal(f.api.filterBySeason(list, 2).length, 2);
    assert.deepEqual(plain(f.api.extractSeasons(list)), [1, 2, 3, 4]);
});
for (const [value, expected] of [['auto', 30], ['', 30], ['undefined', 30], ['bad', 30], ['0', 0], ['12,5', 12.5]]) {
    test('size limit: ' + value, () => { const f = fixture(); f.storage.bq_maxgb = value; assert.equal(f.api.sizeLimit(), expected); });
}
test('empty size setting migrates to visible auto, explicit zero survives', () => {
    const f = fixture(); f.storage.bq_maxgb = ''; f.api.addSettings();
    assert.equal(f.storage.bq_maxgb, 'auto');
    assert.equal(f.params.find(p => p.param.name === 'bq_maxgb').param.placeholder, 'auto');
    f.storage.bq_maxgb = '0'; f.api.addSettings(); assert.equal(f.storage.bq_maxgb, '0');
});
test('unknown HDR does not mean unsupported; explicit SDR does', () => {
    const f = fixture(); f.storage.bq_hdr = 'auto';
    assert.equal(f.api.hdrMode(), 'ignore');
    f.window.matchMedia = query => ({ media: query, matches: query === '(dynamic-range: standard)' });
    assert.equal(f.api.hdrMode(), 'avoid');
    f.window.matchMedia = query => ({ media: query, matches: query === '(dynamic-range: high)' });
    assert.equal(f.api.hdrMode(), 'prefer');
});
test('codec auto uses browser hints and preserves manual choice', () => {
    const f = fixture();
    f.context.document.createElement = () => ({ canPlayType: mime => mime.includes('avc1') ? 'probably' : '' });
    assert.equal(f.api.codecPreference(), 'avc');
    f.storage.bq_codec = 'hevc'; assert.equal(f.api.codecPreference(), 'hevc');
});
test('one wrong-season file cannot bypass validation', () => {
    const f = fixture(); f.api.state(true, 1); let rejected = 0;
    f.api.playInTorrserve({ Link: 'https://fixture.invalid/data', Title: 'Example S01' }, { title: 'Example' }, () => rejected++);
    f.requests.shift().done({ hash: 'fixture' });
    f.requests.shift().done({ file_stats: [{ path: 'Example.S02E01.mp4', id: 3 }] });
    assert.equal(rejected, 1); assert.equal(f.plays.length, 0);
});
test('original file index survives filtering and sorting', () => {
    const f = fixture(); f.api.state(true, 1);
    f.api.playInTorrserve({ Link: 'https://fixture.invalid/data' }, { title: 'Example' }, () => assert.fail('unexpected failure'));
    f.requests.shift().done({ hash: 'fixture' });
    f.requests.shift().done({ file_stats: [{ path: 'notes.txt' }, { path: 'Example.S01E02.mp4' }, { path: 'Example.S01E01.mp4' }] });
    f.selection().onSelect({ index: 0 });
    assert.match(f.plays[0].url, /index=3&play/);
});
test('late add response cannot launch after a newer operation', () => {
    const f = fixture(); f.api.state(true, 1);
    f.api.playInTorrserve({ Link: 'https://fixture.invalid/data' }, { title: 'Example' }, () => assert.fail('stale retry'));
    const pending = f.requests.shift(); f.api.cancel(); pending.done({ hash: 'fixture' });
    assert.equal(f.requests.length, 0); assert.equal(f.plays.length, 0);
});
test('metadata deadline fires once; a late response is ignored', () => {
    const f = fixture(); let failures = 0, successes = 0;
    f.api.waitFiles('fixture', () => successes++, () => failures++);
    f.tick(20000); assert.equal(failures, 1);
    f.requests.shift().done({ file_stats: [{ path: 'Example.mp4' }] });
    assert.equal(successes, 0); f.tick(30000); assert.equal(failures, 1);
});
test('any audio preference gives identical language scores', () => {
    const f = fixture(); f.api.state(true, 1);
    assert.equal(f.api.scoreRelease({ Title: 'Example S01 1080p UKR', Seeders: 20 }), f.api.scoreRelease({ Title: 'Example S01 1080p RUS', Seeders: 20 }));
});
test('new search ignores old parser responses', () => {
    const f = fixture(), searches = [];
    f.api.hooks(null, null, (query, done) => searches.push({ query, done }));
    f.api.findBest({ title: 'First', media_type: 'tv' });
    f.api.findBest({ title: 'Second', media_type: 'tv' });
    searches[0].done([{ Title: 'First S01', Link: 'https://fixture.invalid/first' }]);
    assert.equal(f.requests.length, 0);
    searches[1].done([{ Title: 'Second S02', Link: 'https://fixture.invalid/second', Seeders: 10 }]);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.title, 'Second');
});
test('explicit movie size limit is never relaxed automatically', () => {
    const f = fixture(); f.storage.bq_maxgb = '1'; f.api.state(false, 0);
    f.api.pick([{ Title: 'Example 1080p', Size: 5 * 1073741824, Seeders: 50, Link: 'https://fixture.invalid/data' }], { title: 'Example' });
    assert.equal(f.requests.length, 0);
    assert.match(f.notices[0], /ліміт розміру/);
});
test('buffer deadline is independent of a stalled status request', () => {
    const f = fixture(); f.storage.bq_warm = true;
    let starts = 0, aborts = 0;
    f.context.XMLHttpRequest = function () { this.open = this.send = () => {}; this.abort = () => aborts++; };
    f.api.warmUp('fixture', 'http://server.invalid/stream?fixture', () => starts++);
    f.tick(12000); assert.equal(starts, 1); assert.equal(aborts, 1);
    f.requests.shift().done({ preloaded_bytes: 100, preload_size: 100 });
    f.tick(30000); assert.equal(starts, 1);
});
test('strict Russian excludes unknown audio and Russian subtitles', () => {
    const f = fixture(); f.storage.bq_voice = 'rus'; f.api.state(true, 1);
    f.api.pick([{ Title: 'Example S01 Original + Rus Sub', Link: 'https://fixture.invalid/data', Seeders: 10 }], { title: 'Example' });
    assert.equal(f.requests.length, 0);
    assert.match(f.notices.at(-1), /староукраїнську озвучку/);
});
test('strict Russian retries Russian candidates without Ukrainian or unknown fallbacks', () => {
    const f = fixture(); f.storage.bq_voice = 'rus'; f.api.state(true, 1);
    f.api.pick([
        { Title: 'Example S01 1080p UKR', Link: 'ukr', Seeders: 90 },
        { Title: 'Example S01 1080p', Link: 'unknown', Seeders: 80 },
        { Title: 'Example S01 720p RUS', Link: 'rus', Seeders: 2 },
        { Title: 'Example S01 480p RUS', Link: 'rus2', Seeders: 1 }
    ], { title: 'Example' });
    assert.equal(f.requests[0].body.link, 'rus');
    f.requests.shift().fail('fixture');
    assert.equal(f.requests[0].body.link, 'rus2');
    f.requests.shift().fail('fixture');
    assert.equal(f.requests.length, 0);
});
test('player receives torrent context and fatal startup error advances candidate', () => {
    const f = fixture(); f.api.state(false, 0);
    f.api.pick([
        { Title: 'Example 1080p AVC', Link: 'first', Seeders: 20 },
        { Title: 'Example 720p AVC', Link: 'second', Seeders: 10 }
    ], { title: 'Example' });
    f.requests.shift().done({ hash: 'one' });
    f.requests.shift().done({ file_stats: [{ path: 'Example.mp4', id: 7 }] });
    assert.equal(f.plays[0].torrent_hash, 'one');
    assert.equal(f.plays[0].path, 'Example.mp4');
    f.plays[0].error(); f.tick(250);
    assert.equal(f.requests[0].body.link, 'second');
});
test('automatic retry preserves the selected episode', () => {
    const f = fixture(); f.api.state(true, 1);
    f.api.pick([
        { Title: 'Example S01 1080p AVC', Link: 'first', Seeders: 20 },
        { Title: 'Example S01 720p AVC', Link: 'second', Seeders: 10 }
    ], { title: 'Example' });
    f.requests.shift().done({ hash: 'one' });
    f.requests.shift().done({ file_stats: [
        { path: 'Example.S01E01.mp4', id: 1 }, { path: 'Example.S01E02.mp4', id: 2 }
    ] });
    f.selection().onSelect({ index: 1 });
    f.plays[0].error(); f.tick(250);
    f.requests.shift().done({ hash: 'two' });
    f.requests.shift().done({ file_stats: [
        { path: 'Example.S01E01.mp4', id: 1 }, { path: 'Example.S01E02.mp4', id: 2 }
    ] });
    assert.match(f.plays[1].url, /index=2&play/);
});
test('Ukrainian mode never falls back to Russian or unknown releases', () => {
    const f = fixture(); f.storage.bq_voice = 'ukr'; f.api.state(false, 0);
    f.api.pick([
        { Title: 'Example 1080p RUS', Link: 'rus', Seeders: 100 },
        { Title: 'Example 1080p', Link: 'unknown', Seeders: 90 },
        { Title: 'Example 720p UKR', Link: 'ukr', Seeders: 1 }
    ], { title: 'Example' });
    assert.equal(f.requests.shift().body.link, 'ukr');
    // A second isolated run rejects both non-Ukrainian candidates before server access.
    const g = fixture(); g.storage.bq_voice = 'ukr'; g.api.state(false, 0);
    g.api.pick([{ Title: 'Example RUS', Link: 'rus' }, { Title: 'Example', Link: 'unknown' }], { title: 'Example' });
    assert.equal(g.requests.length, 0);
    assert.match(g.notices[0], /українськ/);
});
test('failed Ukrainian candidate cannot switch to a Russian fallback', () => {
    const f = fixture(); f.storage.bq_voice = 'ukr'; f.api.state(false, 0);
    f.api.pick([{ Title: 'Example UKR', Link: 'ukr', Seeders: 1 }, { Title: 'Example RUS', Link: 'rus', Seeders: 100 }], { title: 'Example' });
    f.requests.shift().fail('fixture');
    assert.equal(f.requests.length, 0);
});
test('explicit Russian audio metadata overrides a misleading UKR title', () => {
    assert.deepEqual(plain(fixture().api.releaseLanguages({ Title: 'Example UKR', audio_tracks: [{ language: 'rus' }] })), { ukr: false, rus: true });
});
test('built-in player automatically enables Ukrainian among mixed tracks', () => {
    const f = fixture(); f.storage.bq_voice = 'ukr'; f.api.state(false, 0);
    f.api.playInTorrserve({ Title: 'Example UKR RUS', Link: 'fixture' }, { title: 'Example' }, () => assert.fail('unexpected rejection'));
    f.requests.shift().done({ hash: 'fixture' });
    f.requests.shift().done({ file_stats: [{ path: 'Example.mp4', id: 1 }] });
    const tracks = [{ language: 'rus', enabled: true }, { language: 'ukr', enabled: false }];
    f.videoEvents.send('tracks', { tracks });
    assert.equal(tracks[0].enabled, false); assert.equal(tracks[1].enabled, true);
});
test('known Russian-only player tracks trigger automatic rejection', () => {
    const f = fixture(); f.storage.bq_voice = 'ukr'; f.api.state(false, 0);
    let rejections = 0;
    f.api.playInTorrserve({ Title: 'Example UKR', Link: 'fixture' }, { title: 'Example' }, () => rejections++);
    f.requests.shift().done({ hash: 'fixture' });
    f.requests.shift().done({ file_stats: [{ path: 'Example.mp4', id: 1 }] });
    f.videoEvents.send('tracks', { tracks: [{ language: 'rus' }] }); f.tick(250);
    assert.equal(rejections, 1);
});

const card = { id: 42, name: 'Example', original_name: 'Example', media_type: 'tv', number_of_seasons: 3 };
const release = (Title, Link = Title, extra = {}) => ({Title, Link, Seeders: 20, ...extra});
function filesReady(f, paths, hash = 'fixture') {
    f.requests.shift().done({hash});
    f.requests.shift().done({file_stats: paths.map((path, i) => ({path, id: i + 1, length: 100000000}))});
}
function progress(f, seconds = 4) {
    for (let n = 0; n <= seconds; n++) { f.tick(1000); f.videoEvents.send('timeupdate', {current: n, duration: 1200}); }
}

for (const [metadata, expected] of [
    [{ffprobe: [{codec_type: 'audio', tags: {language: 'rus'}}, {codec_type: 'subtitle', tags: {language: 'ukr'}}]}, {ukr: false, rus: true}],
    [{ffprobe: [{codec_type: 'audio', tags: {language: 'eng'}}]}, {ukr: false, rus: false}],
    [{ffprobe: [{codec_type: 'audio', tags: {LANGUAGE: 'UKR'}}]}, {ukr: true, rus: false}],
    [{ffprobe: {streams: [{codec_type: 'audio', tags: {language: 'uk-UA'}}]}}, {ukr: true, rus: false}],
    [{Audio: 'RUS + UKR'}, {ukr: true, rus: true}],
    [{audio_tracks: [{language: 'en', label: 'Ukrainian'}]}, {ukr: false, rus: false}],
    [{ffprobe: [{codec_type: 'audio', tags: {language: 'und', title: 'Український дубляж'}}]}, {ukr: true, rus: false}]
]) test('parser audio streams override title and exclude subtitle streams: ' + JSON.stringify(metadata), () => {
    assert.deepEqual(plain(fixture().api.releaseLanguages({Title: 'Example UKR', ...metadata})), expected);
});

test('ffprobe-only Russian matches have priority over Ukrainian releases', () => {
    const f = fixture(); f.storage.bq_voice = 'rus'; f.api.state(true, 1);
    f.api.pick([release('Example S01 UKR', 'ukr'), release('Example S01', 'rus', {ffprobe: [{codec_type: 'audio', tags: {language: 'rus'}}]})], card);
    assert.equal(f.requests[0].body.link, 'rus');
});
test('Ukrainian fallback priority cannot be reversed by minimum resolution or seeds', () => {
    const f = fixture(); f.storage.bq_voice = 'ukr_rus'; f.storage.bq_res = '1080'; f.storage.bq_seeds = '10'; f.api.state(true, 1);
    f.api.pick([release('Example S01 1080p RUS', 'rus', {Seeders: 900}), release('Example S01 720p UKR', 'ukr', {Seeders: 1})], card);
    assert.equal(f.requests.shift().body.link, 'ukr');
});
test('compatible codec tier wins over 4K bitrate and extended-version bonuses', () => {
    const f = fixture(); f.storage.bq_tv = 'uhd'; f.storage.bq_res = '2160';
    f.context.document.createElement = () => ({canPlayType: mime => mime.includes('avc1') ? 'probably' : ''});
    f.api.pick([release('Example 4K AV1 Extended REMUX', 'av1', {Seeders: 500}), release('Example 720p AVC', 'avc', {Seeders: 5})], {title: 'Example'});
    assert.equal(f.requests[0].body.link, 'avc');
});
test('ffprobe resolution and codec are usable without title tags', () => {
    const f = fixture();
    assert.match(f.api.mediaText(release('Example', 'x', {ffprobe: [{codec_type: 'video', width: 1920, height: 804, codec_name: 'h264'}]})), /h264 1080p/);
});
test('explicit size cap exempts season packs, not movies', () => {
    const f = fixture(); f.api.state(true, 1); f.storage.bq_maxgb = '1';
    f.api.pick([release('Example S01', 'pack', {Size: 100 * 1073741824})], card);
    assert.equal(f.requests[0].body.link, 'pack');
});
test('single episodes remain available after packs fail', () => {
    const f = fixture(); f.api.state(true, 1);
    f.api.pick([release('Example S01E01', 'single', {Seeders: 500}), release('Example S01', 'pack')], card);
    assert.equal(f.requests[0].body.link, 'pack');
    f.requests.shift().fail('no files');
    assert.equal(f.requests[0].body.link, 'single');
});
for (const [path, number] of [['Show.S02E09.mkv', 9], ['Show.02x03.mkv', 3], ['03 - Show.mkv', 3], ['Show.E04.mp4', 4], ['Серія 7.mkv', 7], ['Show.1080p.mkv', 0], ['Show.2022.mkv', 0]]) {
    test('stable episode identity: ' + path, () => assert.equal(fixture().api.episodeOf(path), number));
}
test('retry searches episode number instead of index in a differently ordered pack', () => {
    const f = fixture(); f.api.state(true, 1);
    f.api.pick([release('Example S01 1080p', 'first'), release('Example S01 720p', 'second')], card);
    filesReady(f, ['Show.S01E01.mkv', 'Show.S01E03.mkv']);
    f.selection().onSelect({index: 1}); f.plays[0].error(); f.tick(250);
    filesReady(f, ['Show.S01E03.mkv', 'Show.S01E02.mkv'], 'second');
    assert.match(f.plays[1].path, /S01E03/);
    assert.match(f.plays[1].url, /index=1&play/);
});
test('retry skips a smaller pack lacking the selected episode, never clamps to another', () => {
    const f = fixture(); f.api.state(true, 1);
    f.api.pick([release('Example S01 1080p', 'first'), release('Example S01 720p', 'second')], card);
    filesReady(f, ['Show.S01E01.mkv', 'Show.S01E03.mkv']); f.selection().onSelect({index: 1});
    f.plays[0].error(); f.tick(250); filesReady(f, ['Show.S01E01.mkv'], 'second');
    assert.equal(f.plays.length, 1);
    assert.match(f.api.report().lastFailure, /серії/);
});
test('ambiguous multi-season folder cannot identify every file as every season', () => {
    const f = fixture();
    assert.equal(f.api.filesForSeason([{path: 'Show S01-S03/01.mkv'}], 2, 'Show S01-S03').files.length, 0);
    assert.equal(f.api.filesForSeason([{path: '01.mkv'}], 2, 'Show S02').files.length, 1);
    assert.equal(f.api.filesForSeason([{path: '01.mkv'}], 2, 'Show').files.length, 0);
});
test('general season metadata supports parser results without season in title', () => {
    const f = fixture(); f.api.state(true, 2, 3);
    assert.deepEqual(plain(f.api.extractSeasons([release('Example', 'x', {general: {season: '1-3'}})])), [1,2,3]);
    f.api.playInTorrserve(release('Example', 'x', {general: {season: 2}}), card, () => assert.fail('metadata rejected'));
    filesReady(f, ['Episode 01.mp4']);
    assert.equal(f.plays.length, 1);
});
test('samples in underscore and Cyrillic names never become a movie', () => {
    const f = fixture(); f.api.playInTorrserve(release('Example', 'x'), {title: 'Example'}, () => assert.fail('no movie'));
    filesReady(f, ['Show_sample.mp4', 'ПРИКЛАД_СЕМПЛ.mkv', 'Movie.mp4']);
    assert.equal(f.plays[0].path, 'Movie.mp4'); assert.match(f.plays[0].url, /index=3&play/);
});
test('failed or merely opened playback does not overwrite continue history', () => {
    const f = fixture(); f.api.state(true, 1);
    f.api.playInTorrserve(release('Example S01', 'x'), card, () => {}); filesReady(f, ['Show.S01E01.mp4']);
    assert.equal(f.storage.bq_continue, undefined);
    f.plays[0].error(); f.tick(250); assert.equal(f.storage.bq_continue, undefined);
});
test('continued decoded progress saves verified history and stable timeline identity', () => {
    const f = fixture(); f.api.state(true, 1);
    f.api.playInTorrserve(release('Example S01', 'x'), card, () => {}); filesReady(f, ['Show.S01E02.mp4']);
    progress(f);
    const saved = f.api.contGet(card);
    assert.equal(saved.episode, 2); assert.equal(saved.verified, true); assert.equal(saved.season, 1);
    assert.equal(f.plays[0].timeline.hash, 'tmdb:tv:42:s1:e2');
    assert.equal(f.requests.length, 0);
});
test('one seek-like timeupdate is not reported as successful playback', () => {
    const f = fixture(); f.api.state(true, 1);
    f.api.playInTorrserve(release('Example S01', 'x'), card, () => {}); filesReady(f, ['Show.S01E01.mp4']);
    f.videoEvents.send('timeupdate', {current: 300});
    assert.equal(f.storage.bq_continue, undefined);
});
test('next playlist episode has audio guard, recovery callback and updates history', () => {
    const f = fixture(); f.storage.bq_voice = 'ukr'; f.api.state(true, 1);
    f.api.playInTorrserve(release('Example S01 UKR', 'x'), card, () => {});
    filesReady(f, ['Show.S01E01.mp4', 'Show.S01E02.mp4']); f.selection().onSelect({index: 0}); progress(f);
    const next = f.playlist()[1];
    assert.equal(typeof next.error, 'function');
    assert.doesNotThrow(() => JSON.stringify(f.playlist()));
    f.context.Lampa.Player.close(); f.context.Lampa.Player.play(next);
    const tracks = [{language:'rus', enabled:true}, {language:'ukr', enabled:false}];
    f.videoEvents.send('tracks', {tracks}); progress(f);
    assert.equal(tracks[1].enabled, true); assert.equal(tracks[0].enabled, false);
    assert.equal(f.api.contGet(card).episode, 2);
    assert.equal(f.videoEvents.count('tracks'), 1);
});
test('an explicit Russian track cannot pass because its label says Ukrainian', () => {
    const f = fixture(); f.storage.bq_voice = 'ukr'; let rejected = 0;
    f.api.playInTorrserve(release('Example UKR', 'x'), {title:'Example'}, () => rejected++);
    filesReady(f, ['Movie.mp4']); f.videoEvents.send('tracks', {tracks:[{language:'rus', label:'Ukrainian'}]});
    f.tick(250); assert.equal(rejected, 1);
});
test('startup timeout automatically advances a hung player once', () => {
    const f = fixture();
    f.api.pick([release('Example 1080p', 'first'), release('Example 720p', 'second')], {title:'Example'});
    filesReady(f, ['Movie.mp4']); f.tick(25250);
    assert.equal(f.requests[0].body.link, 'second');
    f.plays[0].error(); f.tick(250); assert.equal(f.requests.length, 1);
});
test('successful progress cancels startup timeout', () => {
    const f = fixture(); let failures = 0;
    f.api.playInTorrserve(release('Example', 'x'), {title:'Example'}, () => failures++);
    filesReady(f, ['Movie.mp4']); progress(f); f.tick(60000);
    assert.equal(failures, 0);
});
test('manual close cancels recovery and stale error callbacks', () => {
    const f = fixture(); let failures = 0;
    f.api.playInTorrserve(release('Example', 'x'), {title:'Example'}, () => failures++);
    filesReady(f, ['Movie.mp4']); f.context.Lampa.Player.close(); f.plays[0].error(); f.tick(60000);
    assert.equal(failures, 0); assert.equal(f.videoEvents.count('tracks'), 0);
});
test('manual pause cannot trigger startup fallback', () => {
    const f = fixture(); let failures = 0;
    f.api.playInTorrserve(release('Example', 'x'), {title:'Example'}, () => failures++);
    filesReady(f, ['Movie.mp4']); f.videoEvents.send('pause'); f.tick(60000);
    assert.equal(failures, 0);
});
test('external launch never triggers a second player or claims verified playback', () => {
    const f = fixture(); f.api.state(true,1); let failures = 0;
    f.api.playInTorrserve(release('Example S01', 'x'), card, () => failures++);
    filesReady(f, ['Show.S01E01.mp4']); f.playerEvents.send('external', f.plays[0]); f.tick(60000);
    assert.equal(failures, 0); assert.equal(f.api.contGet(card).verified, false);
    assert.match(f.api.report().status, /зовнішньому/);
});
test('unrelated player content is never closed by an old callback', () => {
    const f = fixture(); let failures = 0;
    f.api.playInTorrserve(release('Example', 'x'), {title:'Example'}, () => failures++);
    filesReady(f, ['Movie.mp4']); f.context.Lampa.Player.play({url:'https://unrelated.invalid/video'});
    f.plays[0].error(); f.tick(60000); assert.equal(failures, 0);
});
test('new operation removes audio handlers and prevents scheduled retries', () => {
    const f = fixture(); let failures = 0;
    f.api.playInTorrserve(release('Example', 'x'), {title:'Example'}, () => failures++);
    filesReady(f, ['Movie.mp4']); f.plays[0].error(); f.api.cancel(); f.tick(60000);
    assert.equal(failures, 0); assert.equal(f.videoEvents.count('tracks'), 0);
});
test('continue keys separate providers and movie/series IDs; corrupt entries are ignored', () => {
    const f = fixture(); f.storage.bq_continue = JSON.stringify({bad:null, wrong:{card:null}, rubbish:'text'});
    assert.deepEqual(plain(f.api.contAll()), {});
    const data = {link:'link', epTitle:'S01E01', episode:1, season:1};
    f.api.contSave(card, data); f.api.contSave({...card, source:'other'}, {...data, link:'other'});
    assert.equal(f.api.contGet(card).link, 'link'); assert.equal(f.api.contGet({...card, source:'other'}).link, 'other');
    assert.equal(f.api.contGet({...card, media_type:'movie'}), null);
});
test('continue list keeps latest fifteen entries', () => {
    const f = fixture();
    for (let id=1; id<=18; id++) { f.tick(1); f.api.contSave({...card,id}, {link:'x',season:1,episode:1}); }
    assert.equal(Object.keys(f.api.contAll()).length, 15);
    assert.equal(f.api.contGet({...card,id:1}), null);
});
test('dead saved release searches the same season and episode without a new dialog', () => {
    const f = fixture();
    f.api.hooks(null,null, (query, done) => done([release('Example S01','wrong'), release('Example S02','right')]));
    f.api.resumeSaved({card, season:2, episode:3, epTitle:'Show.S02E03', releaseTitle:'Example S02', link:'old', position:80});
    assert.equal(f.requests.shift().body.link,'old');
    // Retry by invoking the stored failure in a separate setup.
    const g = fixture(); g.api.hooks(null,null, (query, done) => done([release('Example S01','wrong'),release('Example S02','right')]));
    g.api.resumeSaved({card, season:2, episode:3, epTitle:'Show.S02E03', releaseTitle:'Example S02', link:'old', position:80});
    g.requests.shift().fail('stale'); assert.equal(g.requests[0].body.link, 'right');
    filesReady(g, ['Show.S02E01.mp4','Show.S02E03.mp4']);
    assert.equal(g.selection(), undefined); assert.match(g.plays[0].path,/S02E03/); assert.equal(g.plays[0].timeline.time,80);
});
test('terminal server error stops candidate loop and reports the cause', () => {
    const f = fixture();
    f.api.pick([release('Example','first'),release('Example 720p','second')], {title:'Example'});
    f.requests.shift().fail({terminal:true,message:'TorrServe відхилив доступ'});
    assert.equal(f.requests.length,0); assert.match(f.notices.at(-1),/відхилив доступ/);
});
test('twelve-candidate limit remains bounded and reports attempted count', () => {
    const f = fixture(); f.api.pick(Array.from({length:20}, (_,i)=>release('Example '+i,'link'+i)), {title:'Example'});
    for(let i=0;i<12;i++) f.requests.shift().fail('bad metadata');
    assert.equal(f.requests.length,0); assert.equal(f.api.report().tried,12);
});
test('search deduplicates infohash across trackers while merging seeds and ffprobe', () => {
    const f = fixture();
    const hash = 'a'.repeat(40);
    f.storage.bq_voice='rus';
    f.api.hooks(null,null,(q,done)=>done([
        release('Example S01','first',{Guid:'tracker1',MagnetUri:'magnet:?xt=urn:btih:'+hash,Seeders:1}),
        release('Example S01','second',{Guid:'tracker2',InfoHash:hash.toUpperCase(),Seeders:80,ffprobe:[{codec_type:'audio',tags:{language:'rus'}}]})
    ]));
    f.api.findBest(card); assert.equal(f.api.report().found,1); assert.equal(f.api.report().candidates,1);
    assert(f.notices.some(text=>/80 сідів/.test(text)));
});
test('search obtains both Ukrainian and Russian title variants', () => {
    const f=fixture(), queries=[];
    f.context.Lampa.Api.sources={tmdb:{get(path,opts,done){ done({name:opts.langs==='uk'?'Приклад':'Пример'}); }}};
    f.api.hooks(null,null,(query,done)=>{queries.push(query);done([]);});
    f.api.findBest(card); assert(queries.includes('Приклад')); assert(queries.includes('Пример')); assert(queries.includes('Example'));
});
test('parser deadlines keep concurrency at two and clear timed-out requests', () => {
    const f=fixture(); let active=0, peak=0, cleared=0;
    f.api.hooks(null,null,()=>{active++;peak=Math.max(active,peak);return ()=>{active--;cleared++;};});
    f.api.findBest({title:'One: two', original_title:'Three: four', release_date:'2020-01-01'});
    f.tick(60000); assert.equal(peak,2); assert.equal(active,0); assert(cleared>=2); assert.match(f.notices.at(-1),/парсера/);
});
test('invalid language values migrate to strict Ukrainian instead of arbitrary behavior', () => {
    const f=fixture();f.storage.bq_voice='bad';assert.equal(f.api.voiceMode(),'ukr');
});
test('4K screen auto-detection uses window.screen and pixel ratio', () => {
    const f=fixture();f.window.screen={width:1920,height:1080};f.window.devicePixelRatio=2;assert.equal(f.api.tvMode(),'uhd');
});
test('settings registration stays singular and diagnostic actions exist', () => {
    const f=fixture();f.api.addSettings();const count=f.params.length;f.api.addSettings();assert.equal(f.params.length,count);
    assert(f.params.some(p=>p.param.name==='bq_last_report'));assert(f.params.some(p=>p.param.name==='bq_cancel'));
});

function xhrMock(f) {
    const calls=[];
    f.context.XMLHttpRequest=function () {
        calls.push(this); this.headers={}; this.aborted=false;
        this.open=(method,url)=>{this.method=method;this.url=url;};
        this.setRequestHeader=(key,value)=>{this.headers[key]=value;};
        this.send=body=>{this.body=body;}; this.abort=()=>{this.aborted=true;};
    };
    return calls;
}

test('Russian selection enables RUS instead of the default Ukrainian track', () => {
    const f = fixture(); f.storage.bq_voice = 'rus';
    f.api.playInTorrserve(release('Example RUS + UKR'), {title:'Example'}, () => assert.fail('rejected'));
    filesReady(f, ['Movie.mkv']);
    const tracks = [{language:'ukr', enabled:true}, {language:'rus', enabled:false}];
    f.videoEvents.send('tracks', {tracks});
    assert.equal(tracks[0].enabled, false); assert.equal(tracks[1].enabled, true);
});
test('UKR and ENG only tracks cannot pass strict Russian even with a misleading title', () => {
    const f = fixture(); f.storage.bq_voice='rus'; f.api.state(true,2);
    f.api.pick([release('Example S02 RUS 1080p','wrong'), release('Example S02 RUS 720p','next')], card, {season:2,episode:1});
    filesReady(f, ['Show.S02E01.[Toloka].mkv']);
    f.videoEvents.send('tracks', {tracks:[{language:'ukr',enabled:true},{language:'eng'}]});
    f.tick(250);
    assert.equal(f.requests[0].body.link,'next'); assert.equal(f.api.contGet(card),null);
    filesReady(f, ['Show.S02E01.mkv','Show.S02E02.mkv']);
    assert.match(f.plays.at(-1).path,/S02E01/); assert.equal(f.selection(),undefined);
});
test('changing to Russian re-searches saved Ukrainian release and keeps episode and time', () => {
    const f = fixture(); f.storage.bq_voice='rus';
    f.api.hooks(null,null,(query,done)=>done([release('Example S02 UKR','ukr'),release('Example S02 RUS','rus')]));
    f.api.resumeSaved({card,season:2,episode:3,epTitle:'Show.S02E03',link:'saved-ukr',languages:{ukr:true,rus:false},position:83});
    assert.equal(f.requests[0].body.link,'rus');
    filesReady(f,['Show.S02E01.mkv','Show.S02E03.mkv']);
    assert.match(f.plays[0].path,/S02E03/); assert.equal(f.plays[0].timeline.time,83);
    assert.equal(f.selection(),undefined);
});
test('matching saved Russian release resumes without another search', () => {
    const f=fixture();f.storage.bq_voice='rus';f.api.hooks(null,null,()=>assert.fail('unnecessary search'));
    f.api.resumeSaved({card,season:1,episode:1,epTitle:'Show.S01E01',link:'saved-rus',languages:{rus:true},position:21});
    assert.equal(f.requests[0].body.link,'saved-rus');filesReady(f,['Show.S01E01.mkv']);assert.equal(f.plays[0].timeline.time,21);
});
test('history uses reported file languages instead of misleading release metadata', () => {
    const f=fixture();f.api.state(true,1);
    f.api.playInTorrserve(release('Example S01 RUS','wrong-metadata'),card,()=>assert.fail('rejected'));
    filesReady(f,['Show.S01E01.mkv']);
    f.videoEvents.send('tracks',{tracks:[{language:'ukr'},{language:'eng'}]});progress(f);
    assert.deepEqual(plain(f.api.contGet(card).languages),{ukr:true,rus:false});
});
test('voice setting renames both Russian labels and preserves stored selection',()=>{
    const f=fixture();f.storage.bq_voice='rus';f.api.addSettings();
    const values=f.params.find(p=>p.param.name==='bq_voice').param.values;
    assert.equal(f.storage.bq_voice,'rus');assert.equal(values.rus,'Староукраїнська');
    assert.equal(values.ukr_rus,'Українська → староукраїнська');
    assert(!Object.values(values).some(label=>/російська/i.test(label)));
});
for(const action of ['add','get']) test('temporary TorrServe network failure retries the same '+action+' once',()=>{
    const f=fixture(),calls=xhrMock(f);let result, failures=0;
    const body=action==='add'?{action,link:'synthetic',save_to_db:false}:{action,hash:'synthetic'};
    f.api.request(body,data=>{result=data;},()=>failures++);
    calls[0].onerror();calls[0].ontimeout();f.tick(799);assert.equal(calls.length,1);f.tick(1);
    assert.equal(calls.length,2);assert.equal(calls[1].url,calls[0].url);assert.equal(calls[1].body,calls[0].body);
    calls[1].status=200;calls[1].responseText='{"hash":"synthetic"}';calls[1].onload();
    calls[0].status=200;calls[0].responseText='{"hash":"stale"}';calls[0].onload();
    f.tick(60000);assert.equal(calls.length,2);assert.equal(failures,0);assert.equal(result.hash,'synthetic');
});
for(const status of [0,502,503,504]) test('TorrServe HTTP '+status+' recovery is bounded and terminal after retry',()=>{
    const f=fixture(),calls=xhrMock(f),errors=[];
    f.api.request({action:'get',hash:'synthetic'},()=>assert.fail('success'),e=>errors.push(e));
    calls[0].status=status;calls[0].onload();f.tick(800);assert.equal(calls.length,2);
    calls[1].status=status;calls[1].onload();f.tick(60000);
    assert.equal(errors.length,1);assert.equal(errors[0].terminal,true);assert.equal(calls.length,2);
    assert.match(errors[0].message,/після повторної спроби/);
});
test('cancelling between reconnect attempts suppresses retries and callbacks',()=>{
    const f=fixture(),calls=xhrMock(f);let results=0;
    f.api.request({action:'get'},()=>results++,()=>results++);calls[0].onerror();f.api.cancel();f.tick(60000);
    assert.equal(calls.length,1);assert.equal(results,0);
});
test('cancelling an active reconnect aborts the second request',()=>{
    const f=fixture(),calls=xhrMock(f);let results=0;
    f.api.request({action:'get'},()=>results++,()=>results++);calls[0].onerror();f.tick(800);
    f.api.cancel();calls[1].onerror();assert(calls[1].aborted);assert.equal(results,0);
});
test('TorrServe timeout retries once and a later success settles normally',()=>{
    const f=fixture(),calls=xhrMock(f);let successes=0;
    f.api.request({action:'get'},()=>successes++,()=>assert.fail('failed'));
    f.tick(15000);calls[0].ontimeout();f.tick(800);
    calls[1].status=200;calls[1].responseText='{}';calls[1].onload();assert.equal(successes,1);
});
test('metadata deadline aborts a pending reconnect without stale callbacks',()=>{
    const f=fixture(),calls=xhrMock(f),errors=[];f.api.hooks(f.api.request);
    f.api.waitFiles('synthetic',()=>assert.fail('success'),e=>errors.push(e));
    f.tick(15000);calls[0].ontimeout();f.tick(800);f.tick(4200);
    assert(calls[1].aborted);assert.equal(errors.length,1);f.tick(60000);assert.equal(calls.length,2);
});
test('buffer deadline cancels a pending status reconnect before launching',()=>{
    const f=fixture(),calls=xhrMock(f);f.storage.bq_warm=true;f.api.hooks(f.api.request);let ready=0;
    f.api.warmUp('synthetic','http://server.invalid/stream?link=synthetic&play',()=>ready++);
    calls[1].onerror();f.tick(800);assert.equal(calls.length,3);f.tick(11200);
    assert(calls[0].aborted);assert(calls[2].aborted);assert.equal(ready,1);f.tick(60000);assert.equal(calls.length,3);
});
test('fallback server selection respects the configured second address',()=>{
    const f=fixture(),calls=xhrMock(f);f.context.Lampa.Torserver.url=()=>'';
    f.storage.torrserver_url='first.invalid:8090';f.storage.torrserver_url_two='second.invalid:8090/';f.storage.torrserver_use_link='two';
    f.api.request({action:'get'},()=>{},()=>{});assert.equal(calls[0].url,'http://second.invalid:8090/torrents');
});
test('requests and stream stay on one server until the next operation',()=>{
    const f=fixture(),calls=xhrMock(f);let address='http://first.invalid';f.context.Lampa.Torserver.url=()=>address;f.api.hooks(f.api.request);
    f.api.playInTorrserve(release('Example','synthetic'),{title:'Example'},()=>assert.fail('rejected'));
    address='http://second.invalid';calls[0].status=200;calls[0].responseText='{"hash":"synthetic"}';calls[0].onload();
    assert.equal(calls[1].url,'http://first.invalid/torrents');
    calls[1].status=200;calls[1].responseText='{"file_stats":[{"id":1,"path":"Movie.mkv"}]}';calls[1].onload();
    assert.match(f.plays[0].url,/^http:\/\/first.invalid\/stream\//);
    f.api.cancel();f.api.request({action:'get'},()=>{},()=>{});assert.equal(calls[2].url,'http://second.invalid/torrents');
});
for (const [status, terminal] of [[401,true],[403,true],[404,true],[500,false]]) test('TorrServe API classifies HTTP '+status,()=>{
    const f=fixture(), calls=xhrMock(f), failures=[];
    f.api.request({action:'get',hash:'synthetic'},()=>assert.fail('unexpected success'),error=>failures.push(error));
    calls[0].status=status;calls[0].onload();calls[0].onerror();
    assert.equal(failures.length,1);assert.equal(failures[0].terminal,terminal);
});
test('TorrServe API sends JSON and UTF-8 basic authentication once',()=>{
    const f=fixture(), calls=xhrMock(f); f.storage.torrserver_auth='true';f.storage.torrserver_login='ім’я';f.storage.torrserver_password='test';
    let response;
    f.api.request({action:'add',link:'synthetic',save_to_db:false}, data=>{response=data;},()=>assert.fail('request failed'));
    assert.equal(calls[0].method,'POST'); assert.equal(calls[0].url,'http://server.invalid/torrents');
    assert.equal(calls[0].timeout,15000);
    assert.equal(calls[0].headers.Authorization,'Basic '+Buffer.from('ім’я:test').toString('base64'));
    assert.equal(JSON.parse(calls[0].body).save_to_db,false);
    calls[0].status=200;calls[0].responseText='{"hash":"synthetic"}';calls[0].onload();
    assert.equal(response.hash,'synthetic');
});
test('TorrServe malformed JSON is a server error and callbacks cannot double settle',()=>{
    const f=fixture(), calls=xhrMock(f), failures=[];
    f.api.request({action:'get'},()=>assert.fail('success'),error=>failures.push(error));
    calls[0].status=200;calls[0].responseText='<html>not an API</html>';calls[0].onload();calls[0].ontimeout();
    assert.equal(failures.length,1);assert.equal(failures[0].terminal,true);
});
test('cancellation aborts owned HTTP request without delivering stale errors',()=>{
    const f=fixture(), calls=xhrMock(f);let completed=0;
    f.api.request({action:'get'},()=>completed++,()=>completed++);
    f.api.cancel();calls[0].onerror();assert(calls[0].aborted);assert.equal(completed,0);
});
test('synchronous transport failure returns actionable server error',()=>{
    const f=fixture();let error;
    f.api.request({action:'get'},()=>assert.fail('success'),e=>{error=e;});
    assert.equal(error.terminal,true);
});
for (const variant of ['Results','results','data','array']) test('parser accepts '+variant+' and ignores malformed rows',()=>{
    const f=fixture();f.storage.jackett_url='https://parser.invalid';f.storage.jackett_key='test-key';let result, url;
    const rows=[null,'bad',17,{title:'Example',size:'1000',seeders:'25',magnet:'magnet:?xt=urn:btih:synthetic'}];
    f.context.Lampa.Reguest=function () {this.timeout=()=>{};this.native=(address,done)=>{url=address;done(variant==='array'?rows:variant==='data'?{data:{Results:rows}}:{[variant]:rows});};};
    f.api.parser('Назва: приклад',rows=>{result=rows;},()=>assert.fail('parser failure'));
    assert.equal(result.length,1);assert.equal(result[0].Seeders,25);assert.equal(result[0].Size,1000);assert.match(url,/apikey=test-key/);assert(url.includes(encodeURIComponent('Назва: приклад')));
});
test('parser API errors are not mislabeled as zero search results',()=>{
    const f=fixture();f.storage.jackett_url='https://parser.invalid';let error;
    f.context.Lampa.Reguest=function () {this.native=(url,done)=>done({error:'invalid key'});};
    f.api.parser('Example',()=>assert.fail('success'),e=>{error=e;});assert.match(error,/помилку/);
});
for(const mode of ['success','auth','timeout']) test('connection diagnostic '+mode+' never claims playback works',()=>{
    const f=fixture();let message,cleared=0;
    f.context.Lampa.Reguest=function () {
        this.timeout=()=>{};this.clear=()=>{cleared++;};
        this.native=(url,done,fail)=>{if(mode==='success')done('HTTP');if(mode==='auth')fail({status:401});};
    };
    f.api.checkServerConnection(text=>{message=text;});if(mode==='timeout')f.tick(8000);
    assert.equal(f.plays.length,0);assert.equal(cleared,1);
    assert.match(message,mode==='success'?/Відтворення не перевірялось/:mode==='auth'?/401/:/8 секунд/);
});
test('buffer threshold and disabled buffering complete once',()=>{
    const f=fixture();let complete=0;f.api.warmUp('x','http://server.invalid/stream?link=x&play',()=>complete++);assert.equal(complete,1);
    f.storage.bq_warm=true;const calls=xhrMock(f);
    f.api.warmUp('x','http://server.invalid/stream?link=x&play',()=>complete++);
    const pending=f.requests.shift();pending.done({preloaded_bytes:50,preload_size:100});f.tick(12000);pending.done({preloaded_bytes:100,preload_size:100});
    assert.equal(complete,2);assert.equal(calls[0].aborted,true);
});

test('search uses Lampa configured parser instead of requiring a separate Jackett URL',()=>{
    const f=fixture();let parameters, result;
    f.context.Lampa.Parser={get(params,done){parameters=params;done({Results:[{title:'Example',seeders:'12',Link:'synthetic'}]});}};
    f.api.parser('Example',list=>{result=list;},()=>assert.fail('failure'));
    assert.equal(parameters.search,'Example');assert.equal(parameters.from_search,true);assert.equal(result[0].Seeders,12);
});
test('cancelling shared parser ignores late results without cancelling other plugins',()=>{
    const f=fixture();let done,returned=0;
    f.context.Lampa.Parser={get(params,callback){done=callback;},clear(){assert.fail('shared cancellation');}};
    const cancel=f.api.parser('Example',()=>returned++,()=>returned++);cancel();done({Results:[]});assert.equal(returned,0);
});
test('legacy parser respects the selected secondary address and key',()=>{
    const f=fixture();let url;f.storage.parser_use_link='two';f.storage.jackett_url='https://primary.invalid';f.storage.jackett_url_two='https://secondary.invalid';f.storage.jackett_key_two='second-key';
    f.context.Lampa.Reguest=function(){this.native=(address,done)=>{url=address;done([]);};};
    f.api.parser('Example',()=>{},()=>assert.fail('failure'));assert.match(url,/secondary\.invalid/);assert.match(url,/second-key/);
});
test('cancelling preload immediately aborts it and never starts playback',()=>{
    const f=fixture(),calls=xhrMock(f);let complete=0;f.storage.bq_warm=true;
    f.api.warmUp('x','http://server.invalid/stream?link=x&play',()=>complete++);f.api.cancel();assert(calls[0].aborted);f.tick(30000);assert.equal(complete,0);
});

test('legacy and invalid select values migrate to visible supported options',()=>{
    const f=fixture();f.storage.bq_voice=true;f.storage.bq_codec='invalid';f.storage.bq_hdr='undefined';f.storage.bq_maxgb='bad';
    f.api.addSettings();assert.equal(f.storage.bq_voice,'ukr');assert.equal(f.storage.bq_codec,'auto');assert.equal(f.storage.bq_hdr,'auto');assert.equal(f.storage.bq_maxgb,'auto');
});
