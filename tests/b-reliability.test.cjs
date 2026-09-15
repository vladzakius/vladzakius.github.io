'use strict';
// Run: node --test tests/b-reliability.test.cjs
// Synthetic metadata only; no network, real torrents, or media playback.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'b.js'), 'utf8');

function fixture() {
    const storage = { bq_warm: false, bq_voice: 'any', bq_hdr: 'ignore', bq_res: 'any' };
    const params = [], notices = [], plays = [], requests = [], timers = new Map();
    let clock = 0, nextTimer = 0, selection;
    const window = { screen: { width: 1920, height: 1080 }, navigator: {} };
    const context = vm.createContext({
        window, console, Date: { now: () => clock },
        document: { createElement: () => ({ canPlayType: () => '' }) },
        setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { at: clock + delay, fn }); return id; },
        clearTimeout: id => timers.delete(id),
        XMLHttpRequest: function () { throw new Error('Network is forbidden in tests'); },
        Lampa: {
            Storage: { get: (key, fallback) => key in storage ? storage[key] : fallback, set: (key, value) => { storage[key] = value; } },
            Listener: { follow() {} },
            SettingsApi: { addComponent() {}, addParam: value => params.push(value) },
            Noty: { show: message => notices.push(message) },
            Select: { show: value => { selection = value; } },
            Controller: { toggle() {} },
            Timeline: { view: key => key },
            Player: { play: value => plays.push(value), playlist() {} },
            Torserver: { url: () => 'http://server.invalid' },
            Api: { img: value => value }
        }
    });
    const exposure = `window.__test = {
        seasonsOfText, extractSeasons, filterBySeason, filesForSeason, isSeriesCard,
        releaseLanguages, scoreRelease, sizeLimit, hdrMode, codecPreference, addSettings,
        playInTorrserve, waitFiles, warmUp, findBest, pick,
        state: function (series, season, max) { curIsSeries = series; curSeason = season; curMaxSeason = max || 0; },
        cancel: function () { operation++; },
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
        selection: () => selection,
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
test('size limit is not silently bypassed for a movie', () => {
    const f = fixture(); f.storage.bq_maxgb = '1'; f.api.state(false, 0);
    f.api.pick([{ Title: 'Example 1080p', Size: 5 * 1073741824, Seeders: 50, Link: 'https://fixture.invalid/data' }], { title: 'Example' });
    assert.equal(f.requests.length, 0);
    assert.match(f.selection().title, /фільтрами/);
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
test('Russian preference does not auto-select Russian subtitles as audio', () => {
    const f = fixture(); f.storage.bq_voice = 'rus'; f.api.state(true, 1);
    f.api.pick([{ Title: 'Example S01 Original + Rus Sub', Link: 'https://fixture.invalid/data', Seeders: 10 }], { title: 'Example' });
    assert.equal(f.requests.length, 0);
    assert.match(f.selection().title, /Мову не вказано/);
});
