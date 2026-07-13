(function () {
    'use strict';

    if (window.best_quality_plugin) return;
    window.best_quality_plugin = true;

    var STORE = {
        tv:     'bq_tv',       // панель ТБ: fhd або uhd
        res:    'bq_res',      // мінімальна бажана роздільність
        codec:  'bq_codec',    // бажаний кодек
        hdr:    'bq_hdr',      // HDR: prefer / ignore / avoid
        maxgb:  'bq_maxgb',    // ліміт розміру, ГБ (0 = без ліміту)
        seeds:  'bq_seeds',    // мінімум сідів
        ukr:    'bq_ukr'       // бонус за українську озвучку
    };

    function cfg(key, def) {
        var v = Lampa.Storage.get(STORE[key], def);
        return v === '' || v === undefined ? def : v;
    }

    // Тривалість поточного фільму в хвилинах — для розрахунку бітрейту
    var curRuntime = 0;

    /* ---------- 0. Автовизначення можливостей екрана ---------- */

    var panelCache = null;

    function detectPanel() {
        if (panelCache) return panelCache;

        var is4k = false, hasHdr = false;

        try {
            var w = (window.screen && screen.width  || 0) * (window.devicePixelRatio || 1);
            var h = (window.screen && screen.height || 0) * (window.devicePixelRatio || 1);
            is4k = Math.max(w, h) >= 3000;
        } catch (e) {}

        try {
            hasHdr = !!(window.matchMedia &&
                (matchMedia('(dynamic-range: high)').matches ||
                 matchMedia('(video-dynamic-range: high)').matches));
        } catch (e) {}

        panelCache = { is4k: is4k, hasHdr: hasHdr };
        return panelCache;
    }

    // Режим панелі з урахуванням «Авто»
    function tvMode() {
        var v = cfg('tv', 'auto');
        if (v === 'fhd' || v === 'uhd') return v;
        return detectPanel().is4k ? 'uhd' : 'fhd';
    }

    // Режим HDR з урахуванням «Авто»
    function hdrMode() {
        var v = cfg('hdr', 'auto');
        if (v === 'prefer' || v === 'ignore' || v === 'avoid') return v;
        return detectPanel().hasHdr ? 'prefer' : 'avoid';
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

        // Роздільність — залежить від панелі телевізора
        var tv = tvMode();

        if (tv === 'fhd') {
            // Full HD панель: 1080p — оптимум; 4K лише гріє декодер
            if (/1080/.test(t))             score += 400;
            else if (/1440/.test(t))        score += 200;
            else if (/2160|4k|uhd/.test(t)) score += 120;
            else if (/720/.test(t))         score += 100;
            else                            score += 20;

            // Remux для FHD — марна вага: штраф замість бонусу
            if (/remux/.test(t))            score -= 150;
            else if (/blu.?ray|bdrip/.test(t)) score += 120;
            else if (/web.?dl/.test(t))     score += 90;
            else if (/webrip/.test(t))      score += 60;
            else if (/hdtv/.test(t))        score += 30;
        }
        else {
            // 4K панель: класична драбина
            if (/2160|4k|uhd/.test(t))      score += 500;
            else if (/1440/.test(t))        score += 300;
            else if (/1080/.test(t))        score += 250;
            else if (/720/.test(t))         score += 100;
            else                            score += 20;

            if (/remux/.test(t))            score += 200;
            else if (/blu.?ray|bdrip/.test(t)) score += 120;
            else if (/web.?dl/.test(t))     score += 90;
            else if (/webrip/.test(t))      score += 60;
            else if (/hdtv/.test(t))        score += 30;
        }

        // Українська озвучка
        var ukrOn = cfg('ukr', 'true');
        if ((ukrOn === true || ukrOn === 'true') && /ukr|укр/.test(t)) score += 100;

        // HDR / Dolby Vision — залежить від можливостей телевізора
        var hm = hdrMode();
        var hasDV  = /dolby.?vision|\bdv\b/.test(t);
        var hasHDR = /hdr/.test(t);

        if (hm === 'avoid') {
            // SDR-телевізор: HDR/DV дає темну блеклу картинку — відкидаємо
            if (hasDV || hasHDR) return -1;
        }
        else if (hm === 'prefer') {
            if (hasDV)                score += 120;
            if (/hdr10\+/.test(t))    score += 100;
            else if (hasHDR)          score += 80;
        }

        // Кодек
        var codec = cfg('codec', 'any');
        if (/av1/.test(t) && (codec === 'av1' || codec === 'any')) score += 60;
        if (/(hevc|h\.?265|x265)/.test(t)) score += (codec === 'hevc' ? 100 : 40);
        if (/(avc|h\.?264|x264)/.test(t))  score += (codec === 'avc'  ? 100 : 10);

        // Звук
        if (/(truehd|atmos|dts.?hd|dts.?x)/.test(t)) score += 50;
        else if (/dts|eac3|ddp/.test(t))             score += 20;

        // Бітрейт: рахуємо з розміру і тривалості фільму (Мбіт/с)
        if (curRuntime > 0 && sizeGb > 0) {
            var mbit = (item.Size * 8) / (curRuntime * 60) / 1e6;

            if (tv === 'uhd') {
                // 4K панель: зона комфорту ширша
                if (mbit >= 20 && mbit <= 60)      score += 150;
                else if (mbit >= 10 && mbit < 20)  score += 90;
                else if (mbit > 60 && mbit <= 90)  score += 30;
                else if (mbit > 90)                score -= 80;
                else                               score += 20;
            }
            else {
                // FHD: солодка зона 15–30 Мбіт
                if (mbit >= 15 && mbit <= 30)      score += 150;
                else if (mbit >= 8 && mbit < 15)   score += 90;
                else if (mbit > 30 && mbit <= 45)  score += 20;
                else if (mbit > 45)                score -= 100;
                else                               score += 20;
            }
        }
        else {
            // Тривалість невідома — грубі зони за розміром
            if (sizeGb >= 8 && sizeGb <= 25)      score += 120;
            else if (sizeGb > 4 && sizeGb < 8)    score += 70;
            else if (sizeGb > 25 && sizeGb <= 40) score += 40;
            else if (sizeGb > 40)                 score -= 60;
        }

        // Живучість роздачі
        score += Math.min(seeds, 100) * 1.5;

        return score;
    }

    function passesFilters(item) {
        var t = (item.Title || '').toLowerCase();
        var sizeGb = (item.Size || 0) / 1073741824;
        var maxGb = parseFloat(cfg('maxgb', tvMode() === 'uhd' ? 80 : 30)) || 0;
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

            if (tries >= 13) return fail('Торрент не віддав файли за 20 с');

            if (tries === 3) Lampa.Noty.show('Отримую метадані торрента…');

            setTimeout(function () {
                waitFiles(hash, done, fail, tries + 1);
            }, 1500);
        }, fail);
    }

    function playInTorrserve(item, card, onDead) {
        var link = item.MagnetUri || item.Link;
        var title = card.title || card.name;

        if (!link) {
            if (onDead) return onDead();
            return Lampa.Noty.show('У релізу немає magnet-посилання');
        }

        tsApi({
            action: 'add',
            link: link,
            title: title,
            poster: card.poster_path ? Lampa.Api.img(card.poster_path) : '',
            save_to_db: true
        }, function (torrent) {
            var hash = torrent && torrent.hash;
            if (!hash) {
                if (onDead) return onDead();
                return Lampa.Noty.show('TorrServe не повернув хеш роздачі');
            }

            waitFiles(hash, function (files) {
                var video = files.filter(function (f) {
                    return /\.(mkv|mp4|avi|ts|m4v|mov)$/i.test(f.path);
                }).sort(function (a, b) { return b.length - a.length; })[0];

                if (!video) {
                    // Роздача без відео — прибираємо з TorrServe і далі
                    tsApi({ action: 'rem', hash: hash }, function () {}, function () {});
                    if (onDead) return onDead();
                    return Lampa.Noty.show('У роздачі немає відеофайлу');
                }

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
                // Метадані не прийшли — видаляємо мертвий торрент і пробуємо наступний
                tsApi({ action: 'rem', hash: hash }, function () {}, function () {});
                if (onDead) return onDead();
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

        curRuntime = parseInt(card.runtime, 10) || 0;

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
        var candidates = good.length ? good : scored;

        if (!good.length && scored.length) {
            Lampa.Noty.show('Під фільтри нічого не підійшло (знайдено ' + list.length + '). Беру найкраще з наявного.');
        }

        if (!candidates.length) return Lampa.Noty.show('Знайдено ' + list.length + ', але всі — екранки');

        tryCandidate(candidates, 0, card);
    }

    // Пробуємо кандидатів по черзі: мертва роздача -> наступна за рейтингом
    function tryCandidate(candidates, idx, card) {
        if (idx >= candidates.length || idx >= 3) {
            return Lampa.Noty.show('Живих роздач не знайшлося — спробуй пізніше або обери вручну через Торренти');
        }

        var best = candidates[idx];
        var gb = ((best.Size || 0) / 1073741824).toFixed(1);

        Lampa.Noty.show((idx ? '№' + (idx + 1) + ': ' : '') + best.Title + ' · ' + gb + ' ГБ · ' + (best.Seeders || 0) + ' сідів');

        playInTorrserve(best, card, function () {
            Lampa.Noty.show('Роздача мертва, пробую наступний реліз…');
            tryCandidate(candidates, idx + 1, card);
        });
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
            param: { name: STORE.tv, type: 'select', values: { auto: 'Авто (визначити самому)', fhd: 'Full HD (1080p)', uhd: '4K' }, default: 'auto' },
            field: { name: 'Панель телевізора', description: 'Авто: плагін сам визначає роздільність екрана цього пристрою' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.ukr, type: 'trigger', default: true },
            field: { name: 'Перевага українській озвучці' }
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
            param: { name: STORE.hdr, type: 'select', values: { auto: 'Авто (за можливостями ТБ)', prefer: 'Перевага HDR/DV', ignore: 'Не враховувати', avoid: 'Уникати (мій ТБ без HDR)' }, default: 'auto' },
            field: { name: 'HDR і Dolby Vision', description: 'Авто: якщо екран не підтримує HDR, такі релізи відсіюються' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.maxgb, type: 'input', values: '', default: '' },
            field: { name: 'Ліміт розміру, ГБ', description: 'Порожньо — авто (30 для FHD, 80 для 4K), 0 — без обмеження' }
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
