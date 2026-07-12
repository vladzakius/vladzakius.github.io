(function () {
    'use strict';

    if (window.best_quality_plugin) return;
    window.best_quality_plugin = true;

    var STORE = {
        res:    'bq_res',      // мінімальна бажана роздільність
        codec:  'bq_codec',    // бажаний кодек
        hdr:    'bq_hdr',      // пріоритет HDR/DV
        maxgb:  'bq_maxgb',    // ліміт розміру, ГБ (0 = без ліміту)
        seeds:  'bq_seeds'     // мінімум сідів
    };

    function cfg(key, def) {
        var v = Lampa.Storage.get(STORE[key], def);
        return v === '' || v === undefined ? def : v;
    }

    /* ---------- 1. Оцінка релізу ---------- */

    // Повертає бал. Чим вище — тим кращий реліз. -1 = відкинути.
    function scoreRelease(item) {
        var t = (item.Title || '').toLowerCase();
        var sizeGb = (item.Size || 0) / 1073741824;
        var seeds = item.Seeders || 0;
        var score = 0;

        // Екранки — відкидаємо одразу. Виняток: маркери якісного джерела
        // в назві (щоб ".TS."-контейнер у BluRay-релізі не потрапив під роздачу).
        var isQualitySource = /remux|blu.?ray|bdrip|web.?dl|webrip/.test(t);
        if (!isQualitySource && /\b(cam|camrip|ts|telesync|tc|telecine|screener|scr|hdcam)\b/.test(t)) return -1;

        // Роздільність — головний фактор
        if (/2160|4k|uhd/.test(t))      score += 500;
        else if (/1440/.test(t))        score += 300;
        else if (/1080/.test(t))        score += 250;
        else if (/720/.test(t))         score += 100;
        else                            score += 20;

        // Джерело
        if (/remux/.test(t))            score += 200;
        else if (/blu.?ray|bdrip/.test(t)) score += 120;
        else if (/web.?dl/.test(t))     score += 90;
        else if (/webrip/.test(t))      score += 60;
        else if (/hdtv/.test(t))        score += 30;

        // HDR / Dolby Vision
        var hdrOn = cfg('hdr', true);
        if (hdrOn === true || hdrOn === 'true') {
            if (/dolby.?vision|\bdv\b/.test(t)) score += 120;
            if (/hdr10\+/.test(t))              score += 100;
            else if (/hdr/.test(t))             score += 80;
        }

        // Кодек
        var codec = cfg('codec', 'any');
        if (/av1/.test(t) && (codec === 'av1' || codec === 'any')) score += 60;
        if (/(hevc|h\.?265|x265)/.test(t)) score += (codec === 'hevc' ? 100 : 40);
        if (/(avc|h\.?264|x264)/.test(t))  score += (codec === 'avc'  ? 100 : 10);

        // Звук
        if (/(truehd|atmos|dts.?hd|dts.?x)/.test(t)) score += 50;
        else if (/dts|eac3|ddp/.test(t))             score += 20;

        // Бітрейт: за відсутності тривалості беремо розмір як проксі
        score += Math.min(sizeGb * 6, 120);

        // Живучість роздачі
        score += Math.min(seeds, 100) * 1.5;

        return score;
    }

    function passesFilters(item) {
        var t = (item.Title || '').toLowerCase();
        var sizeGb = (item.Size || 0) / 1073741824;
        var maxGb = parseFloat(cfg('maxgb', 0)) || 0;
        var minSeeds = parseInt(cfg('seeds', 1), 10) || 0;
        var minRes = cfg('res', '1080');

        if ((item.Seeders || 0) < minSeeds) return false;
        if (maxGb > 0 && sizeGb > maxGb) return false;

        if (minRes === '2160' && !/2160|4k|uhd/.test(t)) return false;
        if (minRes === '1080' && !/2160|4k|uhd|1080|1440/.test(t)) return false;

        return true;
    }

    /* ---------- 2. Пошук у Jackett ---------- */

    function search(query, done, fail) {
        var url = (Lampa.Storage.get('jackett_url', '') || '').trim();
        var key = (Lampa.Storage.get('jackett_key', '') || '').trim();

        if (!url) return fail('Не вказано адресу парсера в налаштуваннях');

        // Адреса може бути записана без схеми (напр. jacred.xyz)
        if (!/^https?:\/\//i.test(url)) url = 'http://' + url;

        // JacRed та подібні працюють без ключа — Jackett його вимагає
        if (!key) key = 'null';

        var api = url.replace(/\/+$/, '') +
            '/api/v2.0/indexers/all/results?apikey=' + encodeURIComponent(key) +
            '&Query=' + encodeURIComponent(query);

        var net = new Lampa.Reguest();

        net.native(api, function (json) {
            var list = (json && json.Results) || [];
            done(list);
        }, function () {
            fail('Парсер не відповідає');
        }, false, { dataType: 'json' });
    }

    /* ---------- 3. Запуск у TorrServe ---------- */

    function tsUrl() {
        var u = '';
        try { u = Lampa.Torserver.url(); } catch (e) {}
        if (!u) u = Lampa.Storage.get('torrserver_url', '');
        u = (u || '').trim();
        if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u;
        return u.replace(/\/+$/, '');
    }

    // POST на /torrents з JSON-тілом
    function tsApi(body, done, fail) {
        var url = tsUrl();
        if (!url) return fail('Не вказано адресу TorrServe');

        var xhr = new XMLHttpRequest();
        xhr.open('POST', url + '/torrents', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.timeout = 15000;

        if (Lampa.Storage.get('torrserver_auth', false)) {
            var login = Lampa.Storage.get('torrserver_login', '');
            var pass = Lampa.Storage.get('torrserver_password', '');
            try {
                xhr.setRequestHeader('Authorization', 'Basic ' +
                    btoa(unescape(encodeURIComponent(login + ':' + pass))));
            } catch (e) {}
        }

        xhr.onload = function () {
            if (xhr.status < 200 || xhr.status >= 300) return fail('TorrServe відповів кодом ' + xhr.status);
            try { done(JSON.parse(xhr.responseText)); }
            catch (e) { fail('TorrServe повернув некоректну відповідь'); }
        };
        xhr.onerror = function () { fail('Немає зв\'язку з TorrServe'); };
        xhr.ontimeout = function () { fail('TorrServe не відповідає'); };

        xhr.send(JSON.stringify(body));
    }

    // Чекаємо, поки торрент підтягне метадані і віддасть список файлів
    function waitFiles(hash, done, fail, tries) {
        tries = tries || 0;

        tsApi({ action: 'get', hash: hash }, function (data) {
            var files = (data && data.file_stats) || [];

            if (files.length) return done(files);

            if (tries >= 20) return fail('Торрент не віддав файли за 30 с — можливо, немає сідів');

            if (tries === 3) Lampa.Noty.show('Отримую метадані торрента…');

            setTimeout(function () {
                waitFiles(hash, done, fail, tries + 1);
            }, 1500);
        }, fail);
    }

    function playInTorrserve(item, card) {
        var link = item.MagnetUri || item.Link;
        var title = card.title || card.name;

        if (!link) return Lampa.Noty.show('У релізу немає magnet-посилання');

        tsApi({
            action: 'add',
            link: link,
            title: title,
            poster: card.poster_path ? Lampa.Api.img(card.poster_path) : '',
            save_to_db: true
        }, function (torrent) {
            var hash = torrent && torrent.hash;
            if (!hash) return Lampa.Noty.show('TorrServe не повернув хеш роздачі');

            waitFiles(hash, function (files) {
                var video = files.filter(function (f) {
                    return /\.(mkv|mp4|avi|ts|m4v|mov)$/i.test(f.path);
                }).sort(function (a, b) { return b.length - a.length; })[0];

                if (!video) return Lampa.Noty.show('У роздачі немає відеофайлу');

                var stream = tsUrl() + '/stream/' +
                    encodeURIComponent(video.path.split('/').pop()) +
                    '?link=' + hash + '&index=' + video.id + '&play';

                Lampa.Player.play({
                    url: stream,
                    title: title,
                    timeline: card.timeline,
                    quality: false
                });

                Lampa.Player.playlist([{ url: stream, title: title }]);
            }, function (msg) {
                Lampa.Noty.show(msg);
            });
        }, function (msg) {
            Lampa.Noty.show(msg);
        });
    }

    /* ---------- 4. Кнопка на картці фільму ---------- */

    function findBest(card) {
        var title = card.title || card.name || '';
        var original = card.original_title || card.original_name || '';

        Lampa.Noty.show('Шукаю найкращий реліз…');

        search(title, function (list) {
            if (!list.length && original && original !== title) {
                search(original, function (list2) { pick(list2, card); },
                    function (m) { Lampa.Noty.show(m); });
            }
            else pick(list, card);
        }, function (msg) {
            Lampa.Noty.show(msg);
        });
    }

    function pick(list, card) {
        if (!list.length) return Lampa.Noty.show('Парсер не знайшов жодного релізу');

        var scored = list
            .map(function (i) { i._score = scoreRelease(i); return i; })
            .filter(function (i) { return i._score > 0; })
            .sort(function (a, b) { return b._score - a._score; });

        var good = scored.filter(passesFilters);
        var best = good[0];

        // Фільтри відсікли все — беремо найкраще з наявного і кажемо про це
        if (!best && scored.length) {
            best = scored[0];
            Lampa.Noty.show('Під фільтри нічого не підійшло (знайдено ' + list.length + '). Беру найкраще з наявного.');
        }

        if (!best) return Lampa.Noty.show('Знайдено ' + list.length + ', але всі — екранки');

        var gb = ((best.Size || 0) / 1073741824).toFixed(1);
        Lampa.Noty.show(best.Title + ' · ' + gb + ' ГБ · ' + (best.Seeders || 0) + ' сідів');

        playInTorrserve(best, card);
    }

    function addButton(e) {
        var render = e.object.activity.render();

        // Подія 'full' може спрацювати повторно — не дублюємо кнопку
        if (render.find('.view--bq').length) return;

        var btn = $('<div class="full-start__button selector view--bq">' +
            '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">' +
            '<circle cx="12" cy="12" r="10"/>' +
            '<polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/>' +
            '</svg>' +
            '<span>Дивитись</span></div>');

        btn.on('hover:enter', function () {
            findBest(e.data.movie);
        });

        var anchor = render.find('.view--torrent');

        if (anchor.length) anchor.after(btn);
        else render.find('.full-start__buttons, .full-start-new__buttons').first().append(btn);
    }

    /* ---------- 5. Налаштування ---------- */

    function addSettings() {
        Lampa.SettingsApi.addComponent({
            component: 'best_quality',
            name: 'Найкраща якість',
            icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>'
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.res, type: 'select', values: { '2160': 'Тільки 4K', '1080': 'Від 1080p', 'any': 'Будь-яка' }, default: '1080' },
            field: { name: 'Мінімальна роздільність' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.codec, type: 'select', values: { any: 'Будь-який', hevc: 'HEVC / H.265', av1: 'AV1', avc: 'H.264' }, default: 'any' },
            field: { name: 'Бажаний кодек', description: 'Врахуй, що вміє твій телевізор' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.hdr, type: 'trigger', default: true },
            field: { name: 'Пріоритет HDR і Dolby Vision' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.maxgb, type: 'input', values: '', default: '0' },
            field: { name: 'Ліміт розміру, ГБ', description: '0 — без обмеження' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.seeds, type: 'input', values: '', default: '1' },
            field: { name: 'Мінімум сідів' }
        });
    }

    /* ---------- Старт ---------- */

    function start() {
        addSettings();
        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite') addButton(e);
        });
    }

    if (window.appready) start();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type === 'ready') start();
    });
})();
