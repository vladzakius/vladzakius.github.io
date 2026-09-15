(function () {
    'use strict';

    var BQ_VERSION = 37;

    // Нова версія має право працювати поверх старої; стара не блокує нову
    if (window.bq_version && window.bq_version >= BQ_VERSION) return;
    window.bq_version = BQ_VERSION;
    window.best_quality_plugin = true;

    var STORE = {
        tv:     'bq_tv',       // панель ТБ: fhd або uhd
        res:    'bq_res',      // мінімальна бажана роздільність
        codec:  'bq_codec',    // бажаний кодек
        hdr:    'bq_hdr',      // HDR: prefer / ignore / avoid
        maxgb:  'bq_maxgb',    // ліміт розміру, ГБ (0 = без ліміту)
        seeds:  'bq_seeds',    // мінімум сідів
        ukr:    'bq_voice',    // пріоритет озвучки (новий ключ: bq_ukr зіпсований старим тригером)
        ext:    'bq_ext',      // пріоритет розширених/режисерських версій
        warm:   'bq_warm',     // буферизація перед стартом
        cont:   'bq_continue'  // пам'ять «дивитись далі»
    };

    function cfg(key, def) {
        var v = Lampa.Storage.get(STORE[key], def);
        return v === '' || v === undefined || v === null || v === 'undefined' ? def : v;
    }

    // Тривалість поточного фільму в хвилинах — для розрахунку бітрейту
    var curRuntime = 0;
    // Серіал: інша логіка розміру, вибір сезону і серії
    var curIsSeries = false;
    var curMaxSeason = 0;
    var curSeason = 0;
    var curYear = 0;
    var operation = 0;

    function isSeriesCard(card) {
        var type = card.media_type || card.type;
        if (type === 'movie') return false;
        return type === 'tv' || type === 'serial' || type === 'series' ||
            !!(card.first_air_date || card.original_name || Number(card.number_of_seasons) > 0 ||
                (Array.isArray(card.seasons) && card.seasons.length) || (card.name && !card.title));
    }

    // Єдиний розбір сезонів для назв релізів і шляхів файлів.
    function seasonsOfText(text) {
        var t = String(text || '').toLowerCase().replace(/_/g, ' ');
        var found = {}, m;
        function add(a, b) {
            a = Number(a); b = b === undefined ? a : Number(b);
            if (a < 1 || b < a || b >= 100) return;
            for (var n = a; n <= b; n++) found[n] = true;
        }
        [
            /\bs(\d{1,2})\s*[-–—]\s*s?(\d{1,2})(?!\d)/g,
            /(?:season[s]?|сезон[иы]?)[\s.:№-]*(\d{1,2})\s*[-–—]\s*(\d{1,2})(?!\d)/g,
            /\b(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(?:season[s]?|сезон[иы]?)/g
        ].forEach(function (re) { while ((m = re.exec(t))) add(m[1], m[2]); });
        [
            /\bs(\d{1,2})(?:e\d|\b)/g,
            /\b(\d{1,2})x\d{1,3}(?!\d)/g,
            /(?:season[s]?|сезон[иы]?)[\s.:№-]*(\d{1,2})(?!\d)/g,
            /\b(\d{1,2})[\s.-]*(?:й\s*)?(?:season[s]?|сезон[иы]?)/g
        ].forEach(function (re) { while ((m = re.exec(t))) add(m[1]); });
        return Object.keys(found).map(Number).sort(function (a, b) { return a - b; });
    }

    function sizeLimit() {
        var raw = String(cfg('maxgb', 'auto')).trim().replace(',', '.');
        var value = Number(raw);
        return raw !== 'auto' && raw !== '' && isFinite(value) && value >= 0 ? value :
            (tvMode() === 'uhd' ? 80 : 30);
    }

    function codecPreference() {
        var preference = cfg('codec', 'auto');
        if (preference !== 'auto') return preference;
        try {
            var video = document.createElement('video');
            if (video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') === 'probably') return 'hevc';
            if (video.canPlayType('video/mp4; codecs="avc1.42E01E"')) return 'avc';
        } catch (e) {}
        // H.264 — найбезпечніший запасний варіант для невідомого пристрою.
        return 'avc';
    }

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
        if (mediaQuery('(dynamic-range: high)') === true ||
            mediaQuery('(video-dynamic-range: high)') === true) return 'prefer';
        if (mediaQuery('(dynamic-range: standard)') === true) return 'avoid';
        return 'ignore';
    }

    function voiceMode() {
        var v = cfg('ukr', 'ukr');
        if (v === true || v === 'true') return 'ukr';
        if (v === false || v === 'false') return 'any';
        return v;
    }

    // Назва дає лише підказку про мову, а не повний список аудіодоріжок.
    function releaseLanguages(item) {
        var title = typeof item === 'string' ? item : (item && item.Title) || '';
        var t = String(title).toLowerCase();
        // Мова субтитрів не доводить наявність відповідної аудіодоріжки.
        t = t.replace(/(?:subtitles?|subs?|субтитр[а-яіїєґ]*|сабы)\s*[:=]\s*[^/|\]\n]+/g, ' ')
            .replace(/(?:rus|ru|russian|ukr|uk|ua|ukrainian|русск[а-я]*|російськ[а-яі]*|українськ[а-яі]*|рус|укр)(?:\s*[+,]\s*(?:eng|rus|ukr))*[\s.-]+(?:subtitles?|subs?|субтитр[а-яіїєґ]*|сабы)(?=$|[^a-zа-яіїєґ])/g, ' ')
            .replace(/(?:subtitles?|subs?|субтитр[а-яіїєґ]*|сабы)[\s.-]+(?:rus|ru|russian|ukr|uk|ua|ukrainian)(?![a-z])/g, ' ');
        if (item && typeof item === 'object') {
            function audioText(value) {
                if (Array.isArray(value)) return value.map(audioText).join(' ');
                if (value && typeof value === 'object') return audioText(value.language || value.lang || value.Language || '');
                return typeof value === 'string' ? value : '';
            }
            t += ' ' + audioText(item.Audio || item.audio || item.audio_tracks || item.audioTracks).toLowerCase();
        }
        return {
            ukr: /(^|[^a-zа-яіїєґ])(?:\d+\s*x\s*)?(?:ukr|uk|ua|ukrainian)(?=$|[^a-zа-яіїєґ])|україн|украин|укр[.\s/+\],)]/.test(t),
            rus: /(^|[^a-zа-яіїєґ])(?:\d+\s*x\s*)?(?:rus|ru|russian)(?=$|[^a-zа-яіїєґ])|русск|росій|(^|[^а-яіїєґ])рус(?=$|[^а-яіїєґ])/.test(t)
        };
    }

    function russianTitle(card, done) {
        var api = Lampa.Api && Lampa.Api.sources && Lampa.Api.sources.tmdb;
        if (!api || typeof api.get !== 'function' || !card.id ||
            (card.source && card.source !== 'tmdb')) return done('');
        var finished = false;
        var timer = setTimeout(function () { finish(''); }, 4500);
        function finish(title) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            done(typeof title === 'string' ? title : '');
        }
        var type = isSeriesCard(card) ? 'tv' : 'movie';
        try {
            api.get(type + '/' + encodeURIComponent(card.id), { langs: 'ru' },
                function (data) { finish(data && (data.title || data.name)); },
                function () { finish(''); });
        } catch (e) { finish(''); }
    }

    /* ---------- Діагностика пристрою (без запуску відео) ---------- */

    function mediaQuery(query) {
        try {
            var m = window.matchMedia && window.matchMedia(query);
            if (!m || m.media === 'not all') return null;
            return !!m.matches;
        } catch (e) { return null; }
    }

    function browserProfile() {
        var nav = window.navigator || {};
        var view = window.screen || {};
        var touch = Number(nav.maxTouchPoints || 0) > 0 || mediaQuery('(pointer: coarse)') === true;
        var hdrHigh = mediaQuery('(dynamic-range: high)');
        var hdrStandard = mediaQuery('(dynamic-range: standard)');
        var video;
        try { video = document.createElement('video'); } catch (e) {}
        function codec(mime) {
            try {
                var answer = video && video.canPlayType && video.canPlayType(mime);
                if (answer === 'probably') return 'заявлена підтримка';
                if (answer === 'maybe') return 'можлива підтримка';
            } catch (e) {}
            return 'підтримку не підтверджено';
        }
        return {
            touch: touch,
            width: Number(view.width) || 0,
            height: Number(view.height) || 0,
            hdr: hdrHigh === true ? 'браузер повідомляє HDR' :
                hdrStandard === true ? 'браузер повідомляє SDR' : 'невідомо',
            avc: codec('video/mp4; codecs="avc1.42E01E"'),
            hevc: codec('video/mp4; codecs="hvc1.1.6.L93.B0"'),
            av1: codec('video/mp4; codecs="av01.0.05M.08"')
        };
    }

    function installDeviceStyles() {
        if (document.getElementById('bq-device-style')) return;
        var style = document.createElement('style');
        style.id = 'bq-device-style';
        style.textContent =
            '.view--bq{touch-action:manipulation;cursor:pointer;}' +
            '.view--bq.focus,.view--bq:focus-visible{outline:2px solid currentColor;outline-offset:3px;}' +
            '@media(pointer:coarse){.view--bq{min-width:44px;min-height:44px;}}' +
            '@media(max-width:600px){.view--bq{min-width:44px;min-height:44px;}}';
        (document.head || document.documentElement).appendChild(style);
    }

    function showDeviceInfo() {
        var p = browserProfile();
        Lampa.Select.show({
            title: 'Пристрій · v' + BQ_VERSION,
            items: [
                { title: 'Керування: ' + (p.touch ? 'сенсорне / пульт за наявності' : 'пульт / клавіатура / миша') },
                { title: 'Екран браузера: ' + p.width + ' × ' + p.height + ' CSS px' },
                { title: 'HDR: ' + p.hdr },
                { title: 'H.264: ' + p.avc },
                { title: 'HEVC: ' + p.hevc },
                { title: 'AV1: ' + p.av1 },
                { title: 'Ці дані не визначають можливості зовнішнього плеєра чи фізичної панелі.' }
            ],
            onSelect: function () {},
            onBack: function () { Lampa.Controller.toggle('settings_component'); }
        });
    }

    function checkServerConnection(done) {
        var address;
        try { address = tsUrl(); } catch (e) { return done('Не вдалося прочитати налаштування сервера'); }
        if (!address) return done('Адресу сервера не налаштовано в Lampa');
        if (!/^https?:\/\/[^/\s?#]+(?:\/[^\s?#]*)?$/i.test(address) || /@/.test(address)) {
            return done('Некоректна адреса сервера або облікові дані в адресі');
        }
        var finished = false;
        var net, timer;
        function finish(message) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            // Прибираємо лише власний діагностичний запит.
            try { if (net && net.clear) net.clear(); } catch (e) {}
            done(message);
        }
        timer = setTimeout(function () { finish('Сервер не відповів за 8 секунд'); }, 8000);
        try {
            net = new Lampa.Reguest();
            if (net.timeout) net.timeout(8000);
            var options = { dataType: 'text' };
            var auth = Lampa.Storage.get('torrserver_auth', false);
            if (auth === true || auth === 'true') {
                var login = Lampa.Storage.get('torrserver_login', '');
                var pass = Lampa.Storage.get('torrserver_password', '');
                options.headers = { Authorization: 'Basic ' + btoa(unescape(encodeURIComponent(login + ':' + pass))) };
            }
            // GET головної сторінки: не додає торрентів і не читає історію.
            net.native(address, function () {
                finish('HTTP-з’єднання із сервером працює. Відтворення не перевірялось.');
            }, function (xhr, status) {
                var code = Number(xhr && xhr.status) || 0;
                if (code === 401) return finish('Сервер вимагає правильний логін і пароль (401)');
                if (code === 403) return finish('Сервер відмовив у доступі (403)');
                if (code) return finish('Сервер повернув HTTP ' + code);
                if (status === 'timeout') return finish('Сервер не відповів за 8 секунд');
                finish('Запит не пройшов: мережа, CORS або обмеження браузера. Точну причину браузер не повідомив.');
            }, false, options);
        } catch (e) { finish('Не вдалося виконати перевірку з цього пристрою'); }
    }

    function addDeviceSettings() {
        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: 'bq_device_info', type: 'button' },
            field: { name: 'Інформація про пристрій', description: 'Екран, керування та можливості браузера' },
            onRender: function (item) { item.on('hover:enter', showDeviceInfo); }
        });
        var busy = false;
        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: 'bq_connection_check', type: 'button' },
            field: { name: 'Перевірити з’єднання', description: 'Перевірка налаштованого сервера без запуску відео' },
            onRender: function (item) {
                item.on('hover:enter', function () {
                    if (busy) return;
                    busy = true;
                    Lampa.Noty.show('Перевіряю з’єднання…');
                    checkServerConnection(function (message) {
                        busy = false;
                        Lampa.Noty.show(message);
                    });
                });
            }
        });
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
        if (!isQualitySource && /\b(cam|camrip|ts|telesync|tc|telecine|screener|scr|hdcam)\b/.test(t)) { item._why = 'cam'; return -1; }

        // 3D-релізи: на звичайному ТБ дають подвійну картинку
        if (/\b3d\b|half.?sbs|\bh?sbs\b|half.?ou|\bh?ou\b|side.?by.?side|over.?under|стерео\s?пар/.test(t)) { item._why = '3d'; return -1; }

        // Картка — ФІЛЬМ: роздачі з явними сезонними маркерами не пропускаємо
        // (напр., фільм «Джентльмени» 2019 vs серіал «Джентльмени» 2024).
        // Перевірку року прибрано: вона хибно різала колекції та перевидання.
        if (!curIsSeries) {
            if (/\bs\d{1,2}(?:e\d{1,3})?\b|сезон[\s.:№]*\d|\d[\s.\-]*(?:й|-й)?\s*сезон|\b\d{1,2}x\d{2}\b|complete\s+series/.test(t)) { item._why = 'series'; return -1; }
        }

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

        // Пріоритет озвучки. 'any' — жодних мовних бонусів
        var vp = cfg('ukr', 'ukr');
        if (vp === true || vp === 'true')   vp = 'ukr';   // міграція зі старого тригера
        if (vp === false || vp === 'false') vp = 'any';

        var languages = releaseLanguages(item);
        var hasUkr = languages.ukr;
        var hasRus = languages.rus;

        if (vp === 'ukr') {
            if (hasUkr) score += 120;
        }
        else if (vp === 'ukr_rus') {
            if (hasUkr) score += 120;
            else if (hasRus) score += 40;
        }
        else if (vp === 'rus') {
            // Невідому мову пропонуємо окремо, без автоматичної підміни.
            if (hasRus) score += 120;
            // Двомовний реліз годиться, але однодоріжковий RUS кращий
            if (hasUkr) score -= 90;
        }
        // vp === 'any' — мова не впливає взагалі

        // Точний збіг обраного сезону цінніший за багатосезонний пак
        if (curIsSeries && curSeason > 0) {
            var reExact = new RegExp('\\bs0?' + curSeason + '(?:e\\d|\\b)|сезон[\\s.:№]*0?' + curSeason + '\\b|\\b0?' + curSeason + '[\\s.\\-]*(?:й|-й)?\\s*сезон');
            if (reExact.test(t)) score += 80;
        }

        // HDR / Dolby Vision — залежить від можливостей телевізора
        var hm = hdrMode();
        var hasDV  = /dolby.?vision|\bdv\b/.test(t);
        var hasHDR = /hdr(?!ip)/.test(t);   // HDRip — це тип джерела, а не HDR

        if (hm === 'avoid') {
            // SDR-телевізор: HDR/DV дає темну блеклу картинку — відкидаємо
            if (hasDV || hasHDR) { item._why = 'hdr'; return -1; }
        }
        else if (hm === 'prefer') {
            if (hasDV)                score += 120;
            if (/hdr10\+/.test(t))    score += 100;
            else if (hasHDR)          score += 80;
        }

        // Кодек
        var codec = codecPreference();
        if (/av1/.test(t)) score += codec === 'av1' ? 100 : codec === 'any' ? 20 : -250;
        if (/(hevc|h\.?265|x265)/.test(t)) score += codec === 'hevc' ? 100 : codec === 'avc' ? -120 : 20;
        if (/(avc|h\.?264|x264)/.test(t))  score += codec === 'avc' ? 100 : 10;

        // Розширені/режисерські версії — найвищий пріоритет
        var extOn = cfg('ext', 'true');
        if (extOn === true || extOn === 'true') {
            if (RE_EXT.test(t)) score += 250;
        }

        // Звук
        if (/(truehd|atmos|dts.?hd|dts.?x)/.test(t)) score += 50;
        else if (/dts|eac3|ddp/.test(t))             score += 20;

        // Бітрейт: рахуємо з розміру і тривалості фільму (Мбіт/с)
        // Для серіалів пропускаємо: сезонний пак великий за визначенням
        if (!curIsSeries && curRuntime > 0 && sizeGb > 0) {
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

            // Фейкове HD: заявлено 1080p+, а бітрейт як у DVD — перестиснутий рип
            if (mbit < 5 && /1080|1440|2160|4k|uhd/.test(t)) score -= 350;
        }
        else if (!curIsSeries) {
            // Тривалість невідома — грубі зони за розміром
            if (sizeGb >= 8 && sizeGb <= 25)      score += 120;
            else if (sizeGb > 4 && sizeGb < 8)    score += 70;
            else if (sizeGb > 25 && sizeGb <= 40) score += 40;
            else if (sizeGb > 40)                 score -= 60;
        }

        // Живучість роздачі
        score += Math.min(seeds, 100) * 1.5;

        // Голодні роздачі — біль при перегляді, хай який реліз хороший.
        // Штраф з'їдає мовний бонус: краще RUS з 50 сідами, ніж UKR із 2
        if (seeds < 3)      score -= 150;
        else if (seeds < 8) score -= 70;

        return score;
    }

    function passesFilters(item) {
        var t = (item.Title || '').toLowerCase();
        var sizeGb = (item.Size || 0) / 1073741824;
        var maxGb = sizeLimit();
        var minSeeds = parseInt(cfg('seeds', 1), 10) || 0;
        var minRes = cfg('res', '1080');

        if ((item.Seeders || 0) < minSeeds) return false;
        if (!curIsSeries && maxGb > 0 && sizeGb > maxGb) return false;

        // Розширені версії часто існують лише в старих SD-релізах —
        // не відсіюємо їх за роздільністю, хай користувач вирішує
        var extOk = isExtended(t) && (function () { var v = cfg('ext', 'true'); return v === true || v === 'true'; })();

        if (!extOk) {
            if (minRes === '2160' && !/2160|4k|uhd/.test(t)) return false;
            if (minRes === '1080' && !/2160|4k|uhd|1080|1440/.test(t)) return false;
        }

        return true;
    }

    /* ---------- 2. Пошук у Jackett ---------- */

    function normalizeResult(item) {
        item = item || {};

        // Jackett-сумісні парсери не завжди дотримуються регістру полів.
        // Зводимо найпоширеніші варіанти до одного формату.
        if (!item.Title) item.Title = item.title || item.Name || item.name || '';
        if (item.Size === undefined) item.Size = item.size || 0;
        if (item.Seeders === undefined) item.Seeders = item.seeders || item.Seeds || item.seeds || 0;
        if (!item.MagnetUri) item.MagnetUri = item.magnetUri || item.magnet || '';
        if (!item.Link) item.Link = item.link || item.DownloadUri || item.downloadUrl || '';

        return item;
    }

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
            // Частина проксі повертає масив напряму або використовує lower-case.
            var list = Array.isArray(json) ? json :
                ((json && (json.Results || json.results || (json.data && (json.data.Results || json.data.results)))) || []);
            done(Array.isArray(list) ? list.map(normalizeResult) : []);
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

        var auth = Lampa.Storage.get('torrserver_auth', false);
        if (auth === true || auth === 'true') {
            var login = Lampa.Storage.get('torrserver_login', '');
            var pass = Lampa.Storage.get('torrserver_password', '');
            try {
                xhr.setRequestHeader('Authorization', 'Basic ' +
                    btoa(unescape(encodeURIComponent(login + ':' + pass))));
            } catch (e) {}
        }

        xhr.onload = function () {
            if (xhr.status < 200 || xhr.status >= 300) return fail('TorrServe відповів кодом ' + xhr.status);
            var data;
            try { data = JSON.parse(xhr.responseText); }
            catch (e) { return fail('TorrServe повернув некоректну відповідь'); }
            done(data);
        };
        xhr.onerror = function () { fail('Немає зв\'язку з TorrServe'); };
        xhr.ontimeout = function () { fail('TorrServe не відповідає'); };

        xhr.send(JSON.stringify(body));
    }

    // Чекаємо, поки торрент підтягне метадані і віддасть список файлів
    function waitFiles(hash, done, fail) {
        var requestId = operation, finished = false, next;
        var deadline = setTimeout(function () { finish(null, 'Метадані не отримано за 20 с'); }, 20000);
        function finish(files, error) {
            if (finished) return;
            finished = true;
            clearTimeout(deadline); clearTimeout(next);
            if (requestId !== operation) return;
            if (error) fail(error); else done(files);
        }
        function poll() {
            if (finished || requestId !== operation) return finish(null, 'Скасовано');
            tsApi({ action: 'get', hash: hash }, function (data) {
                if (finished) return;
                var files = data && data.file_stats;
                if (Array.isArray(files) && files.length) return finish(files);
                next = setTimeout(poll, 1500);
            }, function (error) { finish(null, error); });
        }
        poll();
    }

    // Які сезони реально лежать у файлах роздачі та чи є там обраний
    function filesForSeason(videos, season) {
        function seasonsOf(path) {
            // Найближчий до файлу маркер важливіший за назву батьківської колекції.
            var parts = String(path || '').split(/[\\/]/);
            for (var i = parts.length - 1; i >= 0; i--) {
                var seasons = seasonsOfText(parts[i]);
                if (seasons.length) return seasons;
            }
            return [];
        }

        var bySeason = videos.filter(function (f) {
            return seasonsOf(f.path).indexOf(season) !== -1;
        });

        if (bySeason.length) return { files: bySeason, wrong: null };

        // Обраного сезону немає. Якщо файли взагалі марковані — пак не той
        var present = {};
        videos.forEach(function (f) {
            seasonsOf(f.path).forEach(function (n) { present[n] = true; });
        });
        var marked = Object.keys(present).map(Number).sort(function (a, b) { return a - b; });

        if (marked.length) return { files: [], wrong: marked };

        // Файли без маркерів сезону (одинарний немаркований пак) — довіряємо назві роздачі
        return { files: videos, wrong: null };
    }

    /* ---------- 3а. Пам'ять «Дивитись далі» ---------- */

    function contAll() {
        var v = Lampa.Storage.get(STORE.cont, '{}');
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = {}; } }
        return v || {};
    }

    function contSave(card, data) {
        var all = contAll();
        var id = 'c' + (card.id || (card.title || card.name));

        all[id] = {
            id: id,
            time: Date.now(),
            season: data.season,
            epIndex: data.epIndex,
            epTitle: data.epTitle,
            link: data.link,
            card: {
                id: card.id,
                title: card.title, name: card.name,
                original_title: card.original_title, original_name: card.original_name,
                first_air_date: card.first_air_date,
                number_of_seasons: card.number_of_seasons,
                poster_path: card.poster_path,
                runtime: card.runtime
            }
        };

        // Тримаємо не більше 15 останніх
        var keys = Object.keys(all).sort(function (a, b) { return all[b].time - all[a].time; });
        keys.slice(15).forEach(function (k) { delete all[k]; });

        Lampa.Storage.set(STORE.cont, JSON.stringify(all));
        Lampa.Noty.show('✓ Збережено для «Дивитись далі»');
    }

    function contGet(card) {
        return contAll()['c' + (card.id || (card.title || card.name))] || null;
    }

    // Продовження зі збереженої роздачі; якщо вона померла — звичайний пошук
    function resumeSaved(saved) {
        operation++;
        var card = saved.card;

        curIsSeries = true;
        curSeason = saved.season || 0;
        curMaxSeason = parseInt(card.number_of_seasons, 10) || 0;
        curRuntime = parseInt(card.runtime, 10) || 0;

        Lampa.Noty.show('Відновлюю: ' + (saved.epTitle || 'останню серію'));

        playInTorrserve({ MagnetUri: saved.link, Title: '' }, card, function () {
            Lampa.Noty.show('Збережена роздача недоступна — шукаю заново');
            findBest(card);
        }, { episodeIndex: saved.epIndex });
    }

    /* ---------- 3б. Буферизація перед стартом ---------- */

    function warmUp(hash, streamUrl, done) {
        var w = cfg('warm', 'true');
        if (!(w === true || w === 'true')) return done();

        var finished = false, requestId = operation;
        var t0 = Date.now();
        var lastPre = -1, stallAt = Date.now();
        var deadline = setTimeout(finish, 12000);

        // Штовхаємо TorrServe качати з цієї позиції
        var xhr = new XMLHttpRequest();
        try {
            xhr.open('GET', streamUrl + '&preload', true);
            xhr.timeout = 15000;
            xhr.onload = xhr.onerror = xhr.ontimeout = function () {};
            xhr.send();
        } catch (e) {}

        function finish() {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            try { xhr.abort(); } catch (e) {}
            if (requestId === operation) done();
        }

        (function poll() {
            if (finished) return;
            if (requestId !== operation) return finish();
            // Жорстка стеля 12 с — краще легкий фриз на старті, ніж довге чекання
            if (Date.now() - t0 > 12000) return finish();

            tsApi({ action: 'get', hash: hash }, function (t) {
                if (finished) return;
                if (requestId !== operation) return finish();
                var pre = t && t.preloaded_bytes, size = t && t.preload_size;

                if (pre === undefined || !size) {
                    // TorrServe без полів прогресу — 3 с фори і стартуємо
                    if (Date.now() - t0 > 3000) return finish();
                }
                else {
                    var pct = Math.min(100, Math.round(pre * 100 / size));
                    Lampa.Noty.show('Буферизація ' + pct + '%…');

                    // 50% буфера достатньо для гладкого старту
                    if (pct >= 50) return finish();

                    // Буфер не росте 5 с (мало сідів) — не мучимо людину
                    if (pre > lastPre) { lastPre = pre; stallAt = Date.now(); }
                    else if (Date.now() - stallAt > 5000) return finish();
                }

                setTimeout(poll, 1500);
            }, finish);
        })();
    }

    function playInTorrserve(item, card, onDead, opts) {
        var requestId = operation;
        var season = curSeason, series = curIsSeries;
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
            if (requestId !== operation) return;
            var hash = torrent && torrent.hash;
            if (!hash) {
                if (onDead) return onDead();
                return Lampa.Noty.show('TorrServe не повернув хеш роздачі');
            }

            waitFiles(hash, function (files) {
                if (requestId !== operation) return;
                // Індекс TorrServe стосується початкового списку, до фільтрації та сортування.
                var videos = files.map(function (f, index) {
                    return { path: String(f.path || ''), length: f.length,
                        id: f.id !== undefined && f.id !== null ? f.id : index + 1 };
                }).filter(function (f) {
                    if (!/\.(mkv|mp4|avi|ts|m4v|mov)$/i.test(f.path)) return false;
                    // Семпли й трейлери в паках ламають плеєр
                    if (/\b(sample|семпл|trailer|трейлер)\b/i.test(f.path)) return false;
                    return true;
                });

                if (!videos.length) {
                    if (onDead) return onDead();
                    return Lampa.Noty.show('У роздачі немає відеофайлу');
                }

                function streamOf(f, pos) {
                    var idx = (f.id !== undefined && f.id !== null) ? f.id : (pos + 1);
                    return tsUrl() + '/stream/' +
                        encodeURIComponent(f.path.split('/').pop()) +
                        '?link=' + hash + '&index=' + idx + '&play';
                }

                function timelineOf(f) {
                    try { return Lampa.Timeline.view(hash + '_' + (f.id || f.path)); }
                    catch (e) { return card.timeline; }
                }

                function playerData(f, url, name, list, retryOpts) {
                    var failed = false, startedAt = Date.now();
                    return {
                        url: url,
                        title: name,
                        path: f.path,
                        torrent_hash: hash,
                        timeline: timelineOf(f),
                        playlist: list,
                        quality: false,
                        // Вбудований плеєр повідомляє про фатальну помилку через цей callback.
                        // На старті автоматично пробуємо інший реліз; після 60 с це вже
                        // схоже на обрив поточного перегляду, а не несумісний файл.
                        error: function () {
                            if (failed || requestId !== operation || Date.now() - startedAt > 60000) return;
                            failed = true;
                            try { if (Lampa.Player.close) Lampa.Player.close(); } catch (e) {}
                            setTimeout(function () {
                                if (requestId === operation && onDead) onDead(retryOpts);
                            }, 250);
                        }
                    };
                }

                // Перевіряємо сезон і для одного відеофайлу.
                if (series && season > 0) {
                    var sel = filesForSeason(videos, season);
                    if (sel.wrong) {
                        Lampa.Noty.show('Файли не містять обраного сезону ' + season);
                        if (onDead) onDead();
                        return;
                    }
                    videos = sel.files;
                }

                // Фільм або одиночний файл — граємо одразу
                if (!series || videos.length === 1) {
                    var video = videos.sort(function (a, b) { return b.length - a.length; })[0];
                    var mUrl = streamOf(video, 0);

                    if (series) contSave(card, {
                        season: season, epIndex: 0,
                        epTitle: video.path.split('/').pop(), link: link
                    });

                    warmUp(hash, mUrl, function () {
                        if (requestId !== operation) return;
                        var one = playerData(video, mUrl, title, null,
                            series ? { episodeIndex: 0 } : null);
                        Lampa.Player.play(one);
                        Lampa.Player.playlist([{ url: mUrl, title: title, path: video.path,
                            torrent_hash: hash, timeline: one.timeline }]);
                    });
                    return;
                }

                // Серіал: серії за номерами, вибір + плейлист
                videos.sort(function (a, b) {
                    return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
                });

                var playlist = videos.map(function (f, i) {
                    return { url: streamOf(f, i), title: f.path.split('/').pop(), path: f.path,
                        torrent_hash: hash, timeline: timelineOf(f) };
                });

                function playEpisode(idx) {
                    if (requestId !== operation) return;
                    idx = Math.max(0, Math.min(idx, playlist.length - 1));

                    contSave(card, {
                        season: season, epIndex: idx,
                        epTitle: playlist[idx].title, link: link
                    });

                    warmUp(hash, playlist[idx].url, function () {
                        if (requestId !== operation) return;
                        Lampa.Player.play(playerData(videos[idx], playlist[idx].url,
                            playlist[idx].title, playlist, { episodeIndex: idx }));
                        Lampa.Player.playlist(playlist);
                    });
                }

                // Продовження: серія відома — стартуємо без діалогу
                if (opts && opts.episodeIndex !== undefined) return playEpisode(opts.episodeIndex);

                Lampa.Select.show({
                    title: 'Яка серія?',
                    items: videos.map(function (f, i) {
                        return { title: f.path.split('/').pop(), index: i };
                    }),
                    onSelect: function (item) {
                        Lampa.Controller.toggle('content');
                        playEpisode(item.index);
                    },
                    onBack: function () { Lampa.Controller.toggle('content'); }
                });
            }, function (msg) {
                if (requestId !== operation) return;
                // Таймаут не доводить, що роздача мертва; вона могла вже бути у користувача.
                if (onDead) return onDead();
                Lampa.Noty.show(msg);
            });
        }, function (msg) {
            if (requestId !== operation) return;
            if (onDead) return onDead();
            Lampa.Noty.show(msg);
        });
    }

    /* ---------- 4. Кнопка на картці фільму ---------- */

    function findBest(card) {
        var requestId = ++operation;
        var title = card.title || card.name || '';
        var original = card.original_title || card.original_name || '';

        curRuntime = parseInt(card.runtime, 10) || 0;
        // Серіал: у картки є name/first_air_date замість title/release_date
        curIsSeries = isSeriesCard(card);
        curMaxSeason = parseInt(card.number_of_seasons, 10) || 0;
        curYear = parseInt((card.release_date || card.first_air_date || '').slice(0, 4), 10) || 0;

        Lampa.Noty.show('Шукаю найкращий реліз…');

        // Знайомий серіал: пропонуємо продовжити з місця зупинки
        var saved = curIsSeries ? contGet(card) : null;
        if (saved && saved.link) {
            Lampa.Select.show({
                title: (card.title || card.name),
                items: [
                    { title: '▶ Продовжити: ' + (saved.epTitle || ('сезон ' + saved.season)), act: 'resume' },
                    { title: 'Обрати інший сезон / серію / реліз', act: 'new' }
                ],
                onSelect: function (item) {
                    if (requestId !== operation) return;
                    Lampa.Controller.toggle('content');
                    if (item.act === 'resume') resumeSaved(saved);
                    else doSearch();
                },
                onBack: function () { Lampa.Controller.toggle('content'); }
            });
            return;
        }

        doSearch();

        function doSearch() {
            if (requestId !== operation) return;
            russianTitle(card, runSearch);
        }

        function runSearch(ruTitle) {
            if (requestId !== operation) return;
            // Різні індексатори по-різному обробляють апострофи, тире та рік.
            // Тому формуємо кілька компактних варіантів, але без дублювання.
            var queries = [], querySeen = {};

            function addQuery(q) {
                q = (q || '').replace(/\s+/g, ' ').trim();
                if (!q) return;
                var key = q.toLowerCase();
                if (querySeen[key]) return;
                querySeen[key] = true;
                queries.push(q);
            }

            function addTitleVariants(q) {
                if (!q) return;
                addQuery(q);

                var plain = q
                    .replace(/[’'`]/g, ' ')
                    .replace(/[‐‑‒–—:;,.!?()[\]{}]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

                if (plain && plain.toLowerCase() !== q.toLowerCase()) addQuery(plain);
                if (curYear && !curIsSeries) addQuery(plain + ' ' + curYear);
            }

            // Спершу всі мови: варіанти однієї назви не витісняють інші.
            addQuery(title);
            addQuery(original);
            addQuery(ruTitle);
            addTitleVariants(ruTitle);
            addTitleVariants(title);
            addTitleVariants(original);
            addTitleVariants(card.name);
            addTitleVariants(card.original_name);
            addTitleVariants(card.title);
            addTitleVariants(card.original_title);

            // Не перевантажуємо слабкі Jackett/JacRed інсталяції.
            queries = queries.slice(0, 6);

            var pending = queries.length, merged = [], seen = {}, failMsg = null;

            function add(list) {
                (list || []).forEach(function (i) {
                    i = normalizeResult(i);
                    var key = i.Guid || i.InfoHash || i.MagnetUri || i.Link ||
                        ((i.Title || '').toLowerCase() + '|' + (i.Size || 0));
                    if (seen[key]) return;
                    seen[key] = true;
                    merged.push(i);
                });
            }

            function done() {
                if (--pending > 0) return;
                if (!merged.length && failMsg) return Lampa.Noty.show(failMsg);
                route(merged, card);
            }

            if (!queries.length) return Lampa.Noty.show('У картки немає назви для пошуку');
            // Не більше двох одночасних запитів; кожний має власний таймер.
            var next = 0;
            function launch() {
                if (next >= queries.length) return;
                var q = queries[next++], settled = false;
                var timer = setTimeout(function () {
                    settle([], 'Перевищено час очікування парсера');
                }, 15000);
                function settle(list, error) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (requestId !== operation) return;
                    if (error) failMsg = error;
                    add(list);
                    done();
                    launch();
                }
                try {
                    search(q, function (list) { settle(list); },
                        function (error) { settle([], error); });
                } catch (e) { settle([], 'Помилка запиту до парсера'); }
            }
            launch();
            launch();
        }
    }

    // Розводимо фільми та серіали
    function route(list, card) {
        var requestId = operation;
        if (!list.length) return Lampa.Noty.show('Парсер не знайшов жодного релізу');

        curSeason = 0;

        if (!curIsSeries) return pick(list, card);

        // Серіал: дізнаємось, які сезони взагалі є в роздачах
        var seasons = extractSeasons(list);

        function go(season) {
            if (requestId !== operation) return;
            curSeason = season;
            var filtered = filterBySeason(list, season);

            if (!filtered.length) return Lampa.Noty.show('Роздач сезону ' + season + ' не знайшлося');

            pick(filtered, card);
        }

        if (seasons.length > 1) {
            Lampa.Select.show({
                title: 'Який сезон?',
                items: seasons.map(function (n) { return { title: 'Сезон ' + n, season: n }; }),
                onSelect: function (item) {
                    Lampa.Controller.toggle('content');
                    go(item.season);
                },
                onBack: function () { Lampa.Controller.toggle('content'); }
            });
        }
        else if (seasons.length === 1) go(seasons[0]);
        else pick(list, card);
    }

    // Номери сезонів, що згадуються в назвах роздач
    function extractSeasons(list) {
        var found = {};
        list.forEach(function (i) {
            seasonsOfText(i.Title).forEach(function (n) { found[n] = true; });
        });

        return Object.keys(found).map(Number).filter(function (n) {
            if (n <= 0 || n >= 100) return false;
            if (curMaxSeason > 0 && n > curMaxSeason) return false;
            return true;
        }).sort(function (a, b) { return a - b; });
    }

    // Роздачі потрібного сезону, включно з діапазонами (сезони 1-5, S01-S05)
    function filterBySeason(list, season) {
        return list.filter(function (i) {
            return seasonsOfText(i.Title).indexOf(Number(season)) !== -1;
        });
    }

    // Розширена/режисерська версія
    var RE_EXT = /extended|розширен|расширенн|director'?s?\.?\s?cut|режисерськ|режиссерск|режиссёрск|uncut|unrated|ultimate\s?(edition|cut)|final\s?cut/;
    function isExtended(title) { return RE_EXT.test((title || '').toLowerCase()); }

    // Односерійний реліз: S03E05 (без діапазону), «Серия 5»
    function isSingleEpisode(title) {
        var t = (title || '').toLowerCase();
        if (/\b\d{1,2}x\d{1,3}\b(?!\s*[-–—]\s*\d)/.test(t)) return true;
        if (/\bs\d{1,2}e\d{1,3}\b(?!\s*[-–—]\s*e?\d)/.test(t) && !/\be\d{1,3}\s*[-–—]\s*e?\d/.test(t)) return true;
        if (/серия[\s.:№]*\d/.test(t) && !/серии/.test(t)) return true;
        return false;
    }

    // Чому не лишилося жодного кандидата — конкретна причина, а не здогадка
    function rejectReason(list) {
        var c = {};
        list.forEach(function (i) { var w = i._why || 'other'; c[w] = (c[w] || 0) + 1; });

        var top = Object.keys(c).sort(function (a, b) { return c[b] - c[a]; })[0];
        var txt = {
            cam:    'усі — екранки',
            hdr:    'усі — HDR/Dolby Vision (зміни налаштування HDR)',
            '3d':   'усі — 3D',
            series: 'усі — серіальні роздачі',
            other:  'жоден не підійшов під фільтри'
        }[top] || 'жоден не підійшов під фільтри';

        return 'Знайдено ' + list.length + '; найчастіша причина відсіву (' + c[top] + '): ' + txt.replace(/^усі — /, '');
    }

    function pick(list, card) {
        if (!list.length) return Lampa.Noty.show('Роздач цього сезону не знайшлося');

        var scored = list
            .map(function (i) {
                delete i._why;
                i._score = scoreRelease(i);
                return i;
            })
            // Від'ємний бал означає «слабкий», а не обов'язково «заборонений».
            // Жорсткі відмови scoreRelease позначає через _why.
            .filter(function (i) { return !i._why; })
            .sort(function (a, b) { return b._score - a._score; });

        // Мова задає порядок автоматичної перевірки. Невідомі та запасні
        // варіанти не губимо: вони підуть після явно бажаної мови.
        var voice = voiceMode();
        if (voice !== 'any' && scored.length) {
            var preferred = [], secondary = [], unknown = [], fallback = [];
            scored.forEach(function (i) {
                var lang = releaseLanguages(i);
                if (!lang.ukr && !lang.rus) return unknown.push(i);
                if (voice === 'ukr' && lang.ukr) return preferred.push(i);
                if (voice === 'rus' && lang.rus) return preferred.push(i);
                if (voice === 'ukr_rus' && lang.ukr) return preferred.push(i);
                if (voice === 'ukr_rus' && lang.rus) return secondary.push(i);
                fallback.push(i);
            });
            scored = preferred.concat(secondary, unknown, fallback);
        }

        // Серіал: сезонні паки важливіші за односерійні релізи —
        // інакше свіжа серія онгоінга з тисячами сідів «з'їдає» вибір серії
        if (curIsSeries) {
            var packs = scored.filter(function (i) { return !isSingleEpisode(i.Title); });
            if (packs.length) scored = packs;
        }

        var good = scored.filter(passesFilters);
        var relaxed = scored.filter(function (i) { return good.indexOf(i) === -1; });
        relaxed.forEach(function (i) { i._relaxed = true; });
        var candidates = good.concat(relaxed);

        if (!candidates.length) return Lampa.Noty.show(rejectReason(list));

        tryCandidate(candidates, 0, card);
    }

    // Пробуємо кандидатів по черзі: мертва роздача -> наступна за рейтингом
    function tryCandidate(candidates, idx, card, opts) {
        if (idx >= candidates.length || idx >= 12) {
            return Lampa.Noty.show('Перевірені кандидати не запустилися. Причиною можуть бути метадані, файли або з’єднання; доступність інших роздач не перевірена.');
        }

        var best = candidates[idx];
        var gb = ((best.Size || 0) / 1073741824).toFixed(1);

        Lampa.Noty.show((best._relaxed ? 'Запасний варіант · ' : (idx ? '№' + (idx + 1) + ': ' : '')) +
            best.Title + ' · ' + gb + ' ГБ · ' + (best.Seeders || 0) + ' сідів');

        playInTorrserve(best, card, function (retryOpts) {
            Lampa.Noty.show('Цей кандидат не підійшов, перевіряю наступний…');
            tryCandidate(candidates, idx + 1, card, retryOpts || opts);
        }, opts);
    }

    function addButton(e) {
        var render = e.object.activity.render();

        function insert() {
            // Прибираємо кнопку старої версії плагіна, якщо вона встигла з'явитися
            render.find('.view--bq').not('.view--bq7').remove();

            var row = render.find('.full-start-new__buttons, .full-start__buttons').first();
            var playBtn = row.find('.button--play').first();

            // Кнопка вже стоїть у видимому ряду — все гаразд
            if (row.find('.view--bq7').length) return true;

            var btn = $('<div class="full-start__button selector view--bq view--bq7" role="button" aria-label="Дивитись">' +
                '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" stroke="none">' +
                '<path d="M13 2L4.5 13.5h5L9.5 22 18 10.5h-5L13 2z"/>' +
                '</svg>' +
                '<span>Дивитись</span></div>');

            btn.on('hover:enter', function () {
                findBest(e.data.movie);
            });

            if (playBtn.length) playBtn.after(btn);
            else if (row.length) row.prepend(btn);
            else return false;

            // Пульт ходить по колекції контролера, зібраній ДО нашої вставки.
            // collectionAppend у CUB не завжди чіпляє, тому найнадійніше —
            // перезібрати контролер картки: toggle('full') збирає селектори заново.
            setTimeout(function () {
                try {
                    Lampa.Controller.collectionAppend(btn);
                    var c = Lampa.Controller.enabled();
                    if (c && c.name === 'full') Lampa.Controller.toggle('full');
                } catch (err) {}
            }, 50);

            return true;
        }

        // CUB перебудовує ряд кнопок і змітає сторонні в меню «Источник» —
        // тому вставляємось із запізненням і повторюємо, поки не приживеться
        [300, 900, 1800].forEach(function (delay) {
            setTimeout(insert, delay);
        });
    }

    /* ---------- 5. Налаштування ---------- */

    function addSettings() {
        var maxgb = Lampa.Storage.get(STORE.maxgb, 'auto');
        if (maxgb === '' || maxgb === null || maxgb === undefined || maxgb === 'undefined') {
            Lampa.Storage.set(STORE.maxgb, 'auto');
        }
        Lampa.SettingsApi.addComponent({
            component: 'best_quality',
            name: 'Найкраща якість',
            icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>'
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.tv, type: 'select', values: { auto: 'Авто (визначити самому)', fhd: 'Full HD (1080p)', uhd: '4K' }, default: 'auto' },
            field: { name: 'Екран пристрою', description: 'Авто оцінює роздільність за даними браузера. Для зовнішнього плеєра або ТБ можна обрати вручну' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.ukr, type: 'select', values: { ukr: 'Українська', ukr_rus: 'Українська → староукраїнська', rus: 'Староукраїнська 😅', any: 'Байдуже' }, default: 'ukr' },
            field: { name: 'Пріоритет озвучки', description: 'Впливає лише на вибір релізу. Доріжку всередині файлу обирає плеєр' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.ext, type: 'trigger', default: true },
            field: { name: 'Пріоритет розширених версій', description: 'Extended, Director\'s Cut, режисерська, Uncut, Unrated' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.res, type: 'select', values: { '2160': 'Тільки 4K', '1080': 'Від 1080p', 'any': 'Будь-яка' }, default: '1080' },
            field: { name: 'Мінімальна роздільність' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.codec, type: 'select', values: { auto: 'Авто (за даними браузера)', any: 'Будь-який', hevc: 'HEVC / H.265', av1: 'AV1', avc: 'H.264' }, default: 'auto' },
            field: { name: 'Бажаний кодек', description: 'Авто дає перевагу заявленому браузером кодеку. Для зовнішнього плеєра можна обрати вручну' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.hdr, type: 'select', values: { auto: 'Авто (за можливостями ТБ)', prefer: 'Перевага HDR/DV', ignore: 'Не враховувати', avoid: 'Уникати (мій ТБ без HDR)' }, default: 'auto' },
            field: { name: 'HDR і Dolby Vision', description: 'Авто: враховує HDR/SDR, якщо браузер повідомляє підтримку. Якщо даних немає — не відсіює за HDR' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.maxgb, type: 'input', values: '', default: 'auto', placeholder: 'auto' },
            field: { name: 'Ліміт розміру фільму, ГБ', description: 'auto — 30 для FHD, 80 для 4K; 0 — без обмеження. На сезонні паки не поширюється' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.warm, type: 'trigger', default: true },
            field: { name: 'Буферизація перед стартом', description: 'Чекати наповнення кешу TorrServe, щоб уникнути фризів на початку' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.seeds, type: 'input', values: '', default: '1' },
            field: { name: 'Мінімум сідів' }
        });
    }

    /* ---------- 6. «Дивитись далі» у головному меню ---------- */

    function showContinueList() {
        var all = contAll();
        var items = Object.keys(all)
            .map(function (k) { return all[k]; })
            .sort(function (a, b) { return b.time - a.time; });

        if (!items.length) return Lampa.Noty.show('Поки нічого не дивився через «Дивитись»');

        Lampa.Select.show({
            title: 'Дивитись далі',
            items: items.map(function (e) {
                return {
                    title: (e.card.title || e.card.name) + ' · ' + (e.epTitle || ('сезон ' + e.season)),
                    entry: e
                };
            }),
            onSelect: function (item) {
                Lampa.Controller.toggle('content');
                resumeSaved(item.entry);
            },
            onBack: function () { Lampa.Controller.toggle('content'); }
        });
    }

    function addMenuItem(attempt) {
        attempt = attempt || 0;

        var list = $('.menu .menu__list').eq(0);

        // Меню може ще не намалюватися — пробуємо до 10 разів
        if (!list.length) {
            if (attempt < 10) setTimeout(function () { addMenuItem(attempt + 1); }, 500);
            return;
        }

        if (list.find('[data-action="bq_continue"]').length) return;

        var icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

        var item = $('<li class="menu__item selector" data-action="bq_continue">' +
            '<div class="menu__ico">' + icon + '</div>' +
            '<div class="menu__text">Дивитись далі</div></li>');

        item.on('hover:enter', showContinueList);

        list.append(item);
    }

    /* ---------- Старт ---------- */

    var started = false;
    function start() {
        if (started || window.bq_version !== BQ_VERSION) return;
        started = true;
        installDeviceStyles();
        addSettings();
        addDeviceSettings();
        addMenuItem();
        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite') addButton(e);
        });
        Lampa.Noty.show('«Дивитись» v' + BQ_VERSION + ' активний');
    }

    if (window.appready) start();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type === 'ready') start();
    });
})();
