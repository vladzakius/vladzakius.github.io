(function () {
    'use strict';

    var BQ_VERSION = 40;

    // Нова версія має право працювати поверх старої; стара не блокує нову
    if (window.bq_version && window.bq_version >= BQ_VERSION) return;
    if (typeof window.bq_dispose === 'function') window.bq_dispose();
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
    var audioGuardCleanup = null;
    var requestsToCancel = [];
    var serverAddress = '';
    var progressState = null, progressTimer, progressElement = null;
    var lastReport = { status: 'Ще не запускали пошук', found: 0, candidates: 0, tried: 0, reasons: {} };

    function current(id) { return id === operation && window.bq_version === BQ_VERSION; }
    function beginOperation() {
        operation++;
        stopProgress();
        if (audioGuardCleanup) audioGuardCleanup();
        var pending = requestsToCancel;
        requestsToCancel = [];
        pending.forEach(function (cancel) { try { cancel(); } catch (e) {} });
        serverAddress = '';
        return operation;
    }
    function trackRequest(cancel) {
        requestsToCancel.push(cancel);
        return function () {
            var i = requestsToCancel.indexOf(cancel);
            if (i >= 0) requestsToCancel.splice(i, 1);
        };
    }
    function report(message, reason) {
        stopProgress();
        lastReport.status = message;
        if (reason) lastReport.reasons[reason] = (lastReport.reasons[reason] || 0) + 1;
        Lampa.Noty.show(message);
    }

    // Keep preparation visible without changing notifications owned by Lampa.
    function stopProgress() {
        clearTimeout(progressTimer);
        progressState = null;
        if (progressElement) { progressElement.remove(); progressElement = null; }
    }
    function showProgress(message) {
        if (!progressState) progressState = { id: operation, since: Date.now(), message: '' };
        progressState.message = message;
        lastReport.status = message;
        clearTimeout(progressTimer);
        function render() {
            if (!progressState || !current(progressState.id)) return stopProgress();
            if (typeof $ === 'function' && document.body) {
                if (!progressElement) {
                    if (!document.getElementById('bq-progress-style')) {
                        $('<style id="bq-progress-style">' +
                            '.bq-progress{position:fixed;z-index:10000;left:3%;right:3%;bottom:1em;bottom:calc(1em + env(safe-area-inset-bottom,0px));' +
                            'display:flex;align-items:center;padding:.8em 1em;border-radius:.6em;background:#203630;color:#fff;' +
                            'box-shadow:0 2px 12px #0008;font-size:1em;line-height:1.3;pointer-events:none;}' +
                            '.bq-progress__text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
                            '.bq-progress__time{margin-left:1em;white-space:nowrap;opacity:.8;}' +
                            '.bq-progress__spinner{width:1em;height:1em;flex:none;margin-right:.7em;border:2px solid #ffffff50;' +
                            'border-top-color:#63efb7;border-radius:50%;animation:bq-spin 1s linear infinite;}' +
                            '@keyframes bq-spin{to{transform:rotate(360deg)}}' +
                            '@media(prefers-reduced-motion:reduce){.bq-progress__spinner{animation:none;}}' +
                            '</style>').appendTo(document.head || document.documentElement);
                    }
                    progressElement = $('<div class="bq-progress"><span class="bq-progress__spinner" aria-hidden="true"></span>' +
                        '<span class="bq-progress__text" role="status" aria-live="polite"></span><span class="bq-progress__time" aria-hidden="true"></span></div>').appendTo(document.body);
                }
                var label = progressElement.find('.bq-progress__text');
                if (label.text() !== progressState.message) label.text(progressState.message);
                progressElement.find('.bq-progress__time').text(Math.floor((Date.now() - progressState.since) / 1000) + ' с');
            }
            else Lampa.Noty.show(escapeText(progressState.message), { time: 3000 });
            progressTimer = setTimeout(render, 1000);
        }
        render();
    }
    window.bq_dispose = function () {
        beginOperation();
        if (Lampa.Listener.remove) {
            Lampa.Listener.remove('full', onFull);
            Lampa.Listener.remove('app', onApp);
        }
    };

    function isSeriesCard(card) {
        card = card || {};
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
            var w = (window.screen && window.screen.width  || 0) * (window.devicePixelRatio || 1);
            var h = (window.screen && window.screen.height || 0) * (window.devicePixelRatio || 1);
            is4k = Math.max(w, h) >= 3000;
        } catch (e) {}

        try {
            hasHdr = !!(window.matchMedia &&
                (window.matchMedia('(dynamic-range: high)').matches ||
                 window.matchMedia('(video-dynamic-range: high)').matches));
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
        return ['ukr', 'ukr_rus', 'rus', 'any'].indexOf(v) >= 0 ? v : 'ukr';
    }

    function requiredVoice() {
        var voice = voiceMode();
        return voice === 'ukr' || voice === 'rus' ? voice : '';
    }
    function voiceName(voice) { return voice === 'rus' ? 'староукраїнську' : 'українську'; }

    function trackLanguage(track) {
        track = track || {};
        var tags = track.tags || {};
        var code = String(track.language || track.lang || track.Language || tags.language || tags.LANGUAGE || '').toLowerCase().trim();
        if (/^(uk|ukr|ua|uk[-_].*|ukrainian|українська|украинский)$/.test(code)) return 'ukr';
        if (/^(ru|rus|ru[-_].*|russian|русский|російська)$/.test(code)) return 'rus';
        // Explicit ENG/PL/etc must win over a misleading description containing UKR.
        if (code && !/^(und|unknown|mul|zxx)$/.test(code)) return 'other';
        var hint = releaseLanguages(String(track.label || track.title || tags.title || tags.TITLE || ''));
        return hint.ukr ? 'ukr' : hint.rus ? 'rus' : '';
    }

    function audioMetadata(item) {
        if (!item || typeof item !== 'object') return [];
        var probe = item.ffprobe;
        if (probe && !Array.isArray(probe)) probe = probe.streams;
        var audio = Array.isArray(probe) ? probe.filter(function (s) { return s && s.codec_type === 'audio'; }) : [];
        if (audio.length) return audio;
        audio = item.Audio || item.audio || item.audio_tracks || item.audioTracks;
        return Array.isArray(audio) ? audio : audio ? [audio] : [];
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
            var audio = audioMetadata(item), known = false;
            var audioLanguages = { ukr: false, rus: false };
            audio.forEach(function (track) {
                if (typeof track === 'string') {
                    var hints = releaseLanguages(track);
                    if (hints.ukr || hints.rus) {
                        known = true;
                        audioLanguages.ukr = audioLanguages.ukr || hints.ukr;
                        audioLanguages.rus = audioLanguages.rus || hints.rus;
                        return;
                    }
                }
                var lang = trackLanguage(typeof track === 'string' ? { language: track } : track);
                if (lang) known = true;
                if (lang === 'ukr') audioLanguages.ukr = true;
                if (lang === 'rus') audioLanguages.rus = true;
            });
            if (known) return audioLanguages;
            if (Array.isArray(item.info && item.info.voices)) {
                t += ' ' + item.info.voices.join(' ').toLowerCase();
            }
        }
        return {
            ukr: /(^|[^a-zа-яіїєґ])(?:\d+\s*x\s*)?(?:ukr|uk|ua|ukrainian)(?=$|[^a-zа-яіїєґ])|україн|украин|укр[.\s/+\],)]/.test(t),
            rus: /(^|[^a-zа-яіїєґ])(?:\d+\s*x\s*)?(?:rus|ru|russian)(?=$|[^a-zа-яіїєґ])|русск|росій|(^|[^а-яіїєґ])рус(?=$|[^а-яіїєґ])/.test(t)
        };
    }

    function localizedTitle(card, language, done) {
        var api = Lampa.Api && Lampa.Api.sources && Lampa.Api.sources.tmdb;
        if (!api || typeof api.get !== 'function' || !card.id ||
            (card.source && card.source !== 'tmdb')) return done('');
        var finished = false;
        var timer = setTimeout(function () { finish(''); }, 4500);
        var untrack = trackRequest(function () { finished = true; clearTimeout(timer); });
        function finish(title) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            untrack();
            done(typeof title === 'string' ? title : '');
        }
        var type = isSeriesCard(card) ? 'tv' : 'movie';
        try {
            api.get(type + '/' + encodeURIComponent(card.id), { langs: language },
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

    function mediaText(item) {
        var text = String(item.Title || '').toLowerCase();
        var general = item.general || {};
        text += ' ' + String(general.resolution || (item.info && item.info.quality) || '').toLowerCase();
        if (general.hdr) text += ' hdr';
        var probe = item.ffprobe;
        if (probe && !Array.isArray(probe)) probe = probe.streams;
        (Array.isArray(probe) ? probe : []).forEach(function (s) {
            if (!s || s.codec_type !== 'video') return;
            text += ' ' + (s.codec_name || '');
            // Cropped widescreen video still has its original horizontal resolution.
            var width = Number(s.width) || 0;
            if (width >= 3800) text += ' 2160p';
            else if (width >= 1900) text += ' 1080p';
            else if (width >= 1260) text += ' 720p';
            if (/smpte2084|arib-std-b67/.test(s.color_transfer || '')) text += ' hdr';
            if (/10|12/.test(s.pix_fmt || '')) text += ' 10bit';
        });
        return text;
    }

    // Compatibility is a separate tier: a large bitrate cannot outweigh a safer codec.
    function compatibilityRank(item) {
        var t = mediaText(item), pref = codecPreference();
        var kind = /\bav1\b/.test(t) ? 'av1' : /hevc|h[ .]?265|x265/.test(t) ? 'hevc' :
            /avc|h[ .]?264|x264/.test(t) ? 'avc' : '';
        var rank = !kind ? 1 : pref === 'any' || kind === pref ? 0 : 2;
        if (cfg('codec', 'auto') === 'auto') {
            if (kind === 'avc' && /10[ .-]?bit|hi10p/.test(t)) rank = 3;
            var tracks = audioMetadata(item);
            // Do not reward cinema audio when the browser cannot decode it.
            var supported = tracks.some(function (s) {
                var c = s && s.codec_name;
                if (/^(aac|mp3|opus|vorbis)$/.test(c || '')) return true;
                try {
                    return !!document.createElement('video').canPlayType('audio/mp4; codecs="' +
                        (c === 'eac3' ? 'ec-3' : c === 'ac3' ? 'ac-3' : c || 'unknown') + '"');
                } catch (e) { return false; }
            });
            if (tracks.length && !supported && tracks.every(function (s) { return s && s.codec_name; })) rank += 1;
        }
        return rank;
    }

    // Повертає бал. Чим вище — тим кращий реліз. -1 = відкинути.
    function scoreRelease(item) {
        var t = mediaText(item);
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
            // Мовний фільтр обов'язковий; цей бонус ранжує допущені релізи.
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
        // Цей бал порівнює релізи лише всередині мовного пріоритету
        if (seeds < 3)      score -= 150;
        else if (seeds < 8) score -= 70;

        return score;
    }

    function passesFilters(item) {
        var t = mediaText(item);
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
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        var copy = {};
        Object.keys(item).forEach(function (k) { if (k !== '__proto__') copy[k] = item[k]; });
        item = copy;

        // Jackett-сумісні парсери не завжди дотримуються регістру полів.
        // Зводимо найпоширеніші варіанти до одного формату.
        if (!item.Title) item.Title = item.title || item.Name || item.name || '';
        if (item.Size === undefined) item.Size = item.size || 0;
        if (item.Seeders === undefined) item.Seeders = item.seeders || item.Seeds || item.seeds || 0;
        if (!item.MagnetUri) item.MagnetUri = item.magnetUri || item.magnet || '';
        if (!item.Link) item.Link = item.link || item.DownloadUri || item.downloadUrl || '';
        item.Title = String(item.Title || '');
        item.Size = Math.max(0, Number(item.Size) || 0);
        item.Seeders = Math.max(0, parseInt(item.Seeders, 10) || 0);
        if (!isFinite(item.Size)) item.Size = 0;
        if (typeof item.MagnetUri !== 'string') item.MagnetUri = '';
        if (typeof item.Link !== 'string') item.Link = '';
        return item;
    }

    function search(query, done, fail) {
        function results(json) {
            var list = Array.isArray(json) ? json :
                (json && (json.Results || json.results || (json.data && (json.data.Results || json.data.results)))) || [];
            return Array.isArray(list) ? list.map(normalizeResult).filter(Boolean) : [];
        }
        // Use the same configured parser and primary/secondary sources as Lampa.
        // Its network instance is shared: cancellation must NOT call Parser.clear().
        if (Lampa.Parser && typeof Lampa.Parser.get === 'function') {
            var settled = false;
            var release = trackRequest(function () { settled = true; });
            try {
                Lampa.Parser.get({ search: query, from_search: true }, function (json) {
                    if (settled) return;
                    settled = true; release(); done(results(json));
                }, function () {
                    if (settled) return;
                    settled = true; release(); fail('Налаштований парсер не відповів або відхилив запит');
                });
            } catch (e) {
                if (!settled) { settled = true; release(); fail('Не вдалося звернутися до налаштованого парсера'); }
            }
            return function () { settled = true; release(); };
        }
        // Older Lampa builds may not expose Parser.get.
        var second = Lampa.Storage.get('parser_use_link', 'one') === 'two';
        var url = String(Lampa.Storage.get(second ? 'jackett_url_two' : 'jackett_url', '') || '').trim();
        var key = String(Lampa.Storage.get(second ? 'jackett_key_two' : 'jackett_key', '') || '').trim();

        if (!url) return fail('Не вказано адресу парсера в налаштуваннях');

        // Адреса може бути записана без схеми (напр. jacred.xyz)
        if (!/^https?:\/\//i.test(url)) url = 'http://' + url;

        // JacRed та подібні працюють без ключа — Jackett його вимагає
        if (!key) key = 'null';

        var api = url.replace(/\/+$/, '') +
            '/api/v2.0/indexers/all/results?apikey=' + encodeURIComponent(key) +
            '&Query=' + encodeURIComponent(query);

        var net = new Lampa.Reguest();
        if (net.timeout) net.timeout(15000);
        var untrack = trackRequest(function () { if (net.clear) net.clear(); });

        net.native(api, function (json) {
            untrack();
            // Частина проксі повертає масив напряму або використовує lower-case.
            if (json && (json.Error || json.error)) return fail('Парсер повернув помилку — перевір його налаштування');
            done(results(json));
        }, function (xhr) {
            untrack();
            fail(xhr && (xhr.status === 401 || xhr.status === 403) ?
                'Парсер відхилив доступ — перевір ключ' : 'Парсер не відповідає');
        }, false, { dataType: 'json' });
        return function () { untrack(); if (net.clear) net.clear(); };
    }

    /* ---------- 3. Запуск у TorrServe ---------- */

    function tsUrl() {
        var u = '';
        try { u = Lampa.Torserver.url(); } catch (e) {}
        if (!u) {
            var one = Lampa.Storage.get('torrserver_url', '');
            var two = Lampa.Storage.get('torrserver_url_two', '');
            u = Lampa.Storage.get('torrserver_use_link', 'one') === 'two' ? two || one : one || two;
        }
        u = String(u || '').trim();
        if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u;
        return u.replace(/\/+$/, '');
    }

    // POST на /torrents з JSON-тілом
    function tsApi(body, done, fail) {
        var url = serverAddress || (serverAddress = tsUrl());
        function problem(message, terminal, retryable) { return { message: message, terminal: !!terminal, retryable: !!retryable }; }
        if (!url) return fail(problem('Не вказано адресу TorrServe', true));
        if (!/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/i.test(url) || /@/.test(url)) {
            return fail(problem('Некоректна адреса TorrServe', true));
        }
        var xhr, retryTimer, attempt = 0, settled = false, untrack = function () {};
        var retryMessage = 'Відновлюю зв’язок із TorrServe…', previousPhase = '';
        function restorePhase() {
            if (previousPhase && progressState && progressState.message === retryMessage) showProgress(previousPhase);
        }
        function finish(error, data) {
            if (settled) return;
            settled = true; clearTimeout(retryTimer); untrack();
            restorePhase();
            if (error) fail(error); else done(data);
        }
        function cancel() {
            if (settled) return;
            settled = true; clearTimeout(retryTimer); untrack();
            try { if (xhr) xhr.abort(); } catch (e) {}
        }
        untrack = trackRequest(cancel);
        function send() {
            if (settled) return;
            attempt++;
            var completed = false;
            function receive(error, data) {
                if (completed || settled) return;
                completed = true;
                // Repeat the same operation once, never a different server/release.
                if (error && error.retryable && attempt < 2 && (body.action === 'get' || body.action === 'add')) {
                    lastReport.reconnects = (lastReport.reconnects || 0) + 1;
                    if (progressState) { previousPhase = progressState.message; showProgress(retryMessage); }
                    retryTimer = setTimeout(send, 800);
                    return;
                }
                if (error && error.retryable && attempt > 1) error.message += ' (після повторної спроби)';
                finish(error, data);
            }
            try {
                var request = new XMLHttpRequest();
                xhr = request;
                request.open('POST', url + '/torrents', true);
                request.setRequestHeader('Content-Type', 'application/json');
                request.timeout = 15000;
                var auth = Lampa.Storage.get('torrserver_auth', false);
                if (auth === true || auth === 'true') {
                    var login = Lampa.Storage.get('torrserver_login', '');
                    var pass = Lampa.Storage.get('torrserver_password', '');
                    request.setRequestHeader('Authorization', 'Basic ' + btoa(unescape(encodeURIComponent(login + ':' + pass))));
                }
                request.onload = function () {
                    var status = request.status;
                    var temporary = status === 0 || status === 502 || status === 503 || status === 504;
                    if (status < 200 || status >= 300) return receive(problem(
                        status === 401 || status === 403 ? 'TorrServe відхилив доступ — перевір логін і пароль' :
                        'TorrServe відповів кодом ' + status, status === 401 || status === 403 || status === 404 || temporary, temporary));
                    var data;
                    try { data = JSON.parse(request.responseText); }
                    catch (e) { return receive(problem('TorrServe повернув некоректну відповідь', true)); }
                    receive(null, data);
                };
                request.onerror = function () { receive(problem('Немає зв’язку з TorrServe. Перевір адресу, мережу та доступ із цього пристрою', true, true)); };
                request.ontimeout = function () { receive(problem('TorrServe не відповів за 15 с', true, true)); };
                request.send(JSON.stringify(body));
            } catch (e) { receive(problem('Не вдалося виконати запит до TorrServe', true)); }
        }
        send();
        return cancel;
    }

    // Чекаємо, поки торрент підтягне метадані і віддасть список файлів
    function waitFiles(hash, done, fail) {
        var requestId = operation, finished = false, next, cancelRequest;
        var deadline = setTimeout(function () { finish(null, 'Метадані не отримано за 20 с'); }, 20000);
        var untrack = trackRequest(function () { finish(null, 'Скасовано'); });
        function finish(files, error) {
            if (finished) return;
            finished = true;
            clearTimeout(deadline); clearTimeout(next);
            if (typeof cancelRequest === 'function') cancelRequest();
            untrack();
            if (!current(requestId)) return;
            if (error) fail(error); else done(files);
        }
        function poll() {
            if (finished || !current(requestId)) return finish(null, 'Скасовано');
            cancelRequest = tsApi({ action: 'get', hash: hash }, function (data) {
                if (finished) return;
                var files = data && data.file_stats;
                if (Array.isArray(files) && files.length) return finish(files);
                next = setTimeout(poll, 1500);
            }, function (error) { finish(null, error); });
        }
        poll();
    }

    // Які сезони реально лежать у файлах роздачі та чи є там обраний
    function filesForSeason(videos, season, releaseTitle) {
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
            var marked = seasonsOf(f.path);
            return marked.length === 1 && marked[0] === season;
        });

        if (bySeason.length) return { files: bySeason, wrong: null };

        // Обраного сезону немає. Якщо файли взагалі марковані — пак не той
        var present = {};
        videos.forEach(function (f) {
            seasonsOf(f.path).forEach(function (n) { present[n] = true; });
        });
        var marked = Object.keys(present).map(Number).sort(function (a, b) { return a - b; });

        if (marked.length) return { files: [], wrong: marked };

        // An unmarked file is safe only inside a single-season release.
        var releaseSeasons = seasonsOfText(releaseTitle);
        return releaseSeasons.length === 1 && releaseSeasons[0] === season ?
            { files: videos, wrong: null } : { files: [], wrong: [] };
    }

    function releaseSeasonText(item) {
        var general = item.general || {};
        return String(item.Title || '') + (general.season ? ' сезон ' + String(general.season) : '');
    }

    function baseName(path) { return String(path || '').split(/[\\/]/).pop(); }
    function episodeOf(path) {
        var name = baseName(path).replace(/_/g, ' '), m;
        var patterns = [/\bs\d{1,2}[ .-]*e(?:p)?[ .-]*(\d{1,3})(?!\d)/i,
            /\b\d{1,2}x(\d{1,3})(?!\d)/i, /\be(?:p)?[ .-]*(\d{1,3})(?!\d)/i,
            /(?:episode|серія|серия)[ .:№-]*(\d{1,3})(?!\d)/i,
            /\b(\d{1,3})[ .-]*(?:серія|серия|episode)/i,
            /^(\d{1,3})(?=[ ._-]|\.[a-z]+$)/i];
        for (var i = 0; i < patterns.length; i++) {
            m = name.match(patterns[i]);
            if (m && Number(m[1]) > 0) return Number(m[1]);
        }
        return 0;
    }

    function cardKey(card) {
        return [card.source || 'tmdb', isSeriesCard(card) ? 'tv' : 'movie', card.id || card.original_title || card.original_name || card.title || card.name].join(':');
    }

    function escapeText(value) {
        return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /* ---------- 3а. Пам'ять «Дивитись далі» ---------- */

    function contAll() {
        var v = Lampa.Storage.get(STORE.cont, '{}');
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = {}; } }
        if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
        var valid = {};
        Object.keys(v).forEach(function (k) {
            var entry = v[k];
            if (entry && typeof entry === 'object' && entry.card && typeof entry.card === 'object' && typeof entry.link === 'string') valid[k] = entry;
        });
        return valid;
    }

    function contSave(card, data) {
        var all = contAll();
        var id = cardKey(card);
        delete all['c' + (card.id || card.title || card.name)];

        all[id] = {
            id: id,
            time: Date.now(),
            season: data.season,
            epIndex: data.epIndex,
            episode: data.episode,
            path: data.path,
            hash: data.hash,
            position: data.position || 0,
            verified: data.verified,
            epTitle: data.epTitle,
            link: data.link,
            languages: data.languages,
            releaseTitle: data.releaseTitle,
            card: {
                id: card.id,
                source: card.source, media_type: isSeriesCard(card) ? 'tv' : 'movie',
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
    }

    function contGet(card) {
        var all = contAll();
        return all[cardKey(card)] || all['c' + (card.id || (card.title || card.name))] || null;
    }

    // Продовження зі збереженої роздачі; якщо вона померла — звичайний пошук
    function resumeSaved(saved) {
        var requestId = beginOperation();
        lastReport = { status: 'Продовження перегляду', found: 0, candidates: 0, tried: 0, reasons: {} };
        if (!saved || !saved.card) return report('Збережений запис пошкоджено');
        var card = saved.card;
        var opts = { season: saved.season || 0, episode: saved.episode || episodeOf(saved.epTitle),
            path: saved.path || saved.epTitle, hash: saved.hash, episodeIndex: saved.epIndex, position: saved.position || 0 };
        var required = requiredVoice();
        if (required && !(saved.languages && saved.languages[required])) return findBest(card, true, opts);

        curIsSeries = isSeriesCard(card);
        curSeason = saved.season || 0;
        curMaxSeason = parseInt(card.number_of_seasons, 10) || 0;
        curRuntime = parseInt(card.runtime, 10) || 0;

        showProgress('Відновлюю: ' + (saved.epTitle || 'останню серію'));

        playInTorrserve({ MagnetUri: saved.link, Title: saved.releaseTitle || '',
            Audio: saved.languages ? (saved.languages.ukr ? 'ukr ' : '') + (saved.languages.rus ? 'rus' : '') : '' }, card, function (retryOpts, error) {
            if (!current(requestId)) return;
            if (error && error.terminal) return report(error.message, 'server');
            Lampa.Noty.show('Збережена роздача недоступна — шукаю заново');
            findBest(card, true, retryOpts || opts);
        }, opts);
    }

    /* ---------- 3б. Буферизація перед стартом ---------- */

    function warmUp(hash, streamUrl, done) {
        var w = cfg('warm', 'true');
        if (!(w === true || w === 'true')) return done();

        var finished = false, requestId = operation, cancelRequest, next;
        var t0 = Date.now();
        var lastPre = -1, stallAt = Date.now();
        var deadline = setTimeout(finish, 12000);
        var untrack = trackRequest(finish);

        // Штовхаємо TorrServe качати з цієї позиції
        var xhr;
        try {
            xhr = new XMLHttpRequest();
            xhr.open('GET', streamUrl + '&preload', true);
            xhr.timeout = 15000;
            xhr.onload = xhr.onerror = xhr.ontimeout = function () {};
            xhr.send();
        } catch (e) {}

        function finish() {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            clearTimeout(next);
            if (typeof cancelRequest === 'function') cancelRequest();
            untrack();
            try { xhr.abort(); } catch (e) {}
            if (current(requestId)) done();
        }

        (function poll() {
            if (finished) return;
            if (!current(requestId)) return finish();
            // Жорстка стеля 12 с — краще легкий фриз на старті, ніж довге чекання
            if (Date.now() - t0 > 12000) return finish();

            cancelRequest = tsApi({ action: 'get', hash: hash }, function (t) {
                if (finished) return;
                if (!current(requestId)) return finish();
                var pre = t && t.preloaded_bytes, size = t && t.preload_size;

                if (pre === undefined || !size) {
                    // TorrServe без полів прогресу — 3 с фори і стартуємо
                    if (Date.now() - t0 > 3000) return finish();
                }
                else {
                    var pct = Math.min(100, Math.round(pre * 100 / size));
                    showProgress('Буферизація ' + pct + '%…');

                    // 50% буфера достатньо для гладкого старту
                    if (pct >= 50) return finish();

                    // Буфер не росте 5 с (мало сідів) — не мучимо людину
                    if (pre > lastPre) { lastPre = pre; stallAt = Date.now(); }
                    else if (Date.now() - stallAt > 5000) return finish();
                }

                next = setTimeout(poll, 1500);
            }, finish);
        })();
    }

    // A guard belongs to this playlist only. Switching files rebuilds its timers and
    // audio handlers; closing the player never schedules another release.
    function watchPlayback(playlist, card, item, hash, season, onDead) {
        if (audioGuardCleanup) audioGuardCleanup();
        var requestId = operation, active = null, timer, removers = [], videoRemovers = [];
        var failed = false, external = false, lastTime = null, progressed = 0, lastSaved = -15000;
        var voice = voiceMode(), series = curIsSeries;
        var player = Lampa.Player, video = Lampa.PlayerVideo;
        function listen(bus, name, fn, bag) {
            if (!bus || !bus.follow || !bus.remove) return;
            bus.follow(name, fn);
            bag.push(function () { bus.remove(name, fn); });
        }
        function clearVideo() {
            clearTimeout(timer);
            videoRemovers.forEach(function (remove) { remove(); });
            videoRemovers = [];
        }
        function cleanup() {
            stopProgress();
            clearVideo(); active = null;
            removers.forEach(function (remove) { remove(); });
            removers = [];
            if (audioGuardCleanup === cleanup) audioGuardCleanup = null;
        }
        function owns(data) {
            if (!current(requestId) || active !== data || failed || external) return false;
            if (player.playdata) {
                var work = player.playdata();
                if (work && work.url && work !== data && work.url !== data.url) return false;
            }
            return true;
        }
        function remember(data, verified) {
            if (!series) return;
            contSave(card, { season: season, episode: data.bq_episode, epIndex: data.bq_index,
                epTitle: data.title, path: data.path, hash: hash, position: data.bq_position || 0,
                link: item.MagnetUri || item.Link, languages: data.bq_languages || releaseLanguages(item),
                releaseTitle: item.Title, verified: verified });
        }
        function fail(data, reason) {
            if (!owns(data)) return;
            failed = true;
            var retry = { season: season, episode: data.bq_episode, path: data.path, hash: hash,
                episodeIndex: data.bq_index, position: data.bq_position || 0 };
            cleanup();
            try { if (player.close) player.close(); } catch (e) {}
            showProgress('Цей реліз не підійшов — перевіряю наступний…');
            setTimeout(function () {
                if (current(requestId)) onDead(retry, { message: reason, reason: 'playback' });
            }, 250);
        }
        function arm(data) {
            clearTimeout(timer);
            if (progressed >= 3 || !owns(data)) return;
            timer = setTimeout(function () { fail(data, 'Плеєр не почав відтворення за 25 с'); }, 25000);
        }
        function activate(data) {
            if (!current(requestId) || active === data) return;
            clearVideo(); active = data; failed = false; external = false;
            lastTime = null; progressed = 0; lastSaved = -15000;
            listen(video && video.listener, 'tracks', function (event) {
                if (!owns(data)) return;
                var tracks = event && event.tracks || [], ukr = -1, rus = -1;
                for (var i = 0; i < tracks.length; i++) {
                    var lang = trackLanguage(tracks[i]);
                    if (lang === 'ukr' && ukr < 0) ukr = i;
                    if (lang === 'rus' && rus < 0) rus = i;
                }
                if (tracks.length) data.bq_languages = { ukr: ukr >= 0, rus: rus >= 0 };
                if (voice === 'any') return;
                var target = voice === 'rus' ? rus : ukr >= 0 ? ukr : voice === 'ukr_rus' ? rus : -1;
                if (target < 0 && tracks.length && (voice === 'ukr' || voice === 'rus'))
                    return fail(data, 'У файлі не підтверджено ' + voiceName(voice) + ' аудіодоріжку');
                if (target >= 0) {
                    try {
                        // Disable others before enabling the target: HLS/DASH use setters.
                        for (var n = 0; n < tracks.length; n++) {
                            if (n !== target) { tracks[n].enabled = false; tracks[n].selected = false; }
                        }
                        tracks[target].enabled = true;
                        tracks[target].selected = true;
                    } catch (e) { return fail(data, 'Плеєр не дозволив перемкнути аудіодоріжку'); }
                }
            }, videoRemovers);
            listen(video && video.listener, 'timeupdate', function (event) {
                if (!owns(data)) return;
                var now = Number(event && event.current);
                if (!isFinite(now) || now < 0) return;
                // One seek/timeupdate is not proof of decoding. Require continued progress.
                if (lastTime !== null && now > lastTime && now - lastTime < 5) progressed += now - lastTime;
                lastTime = now; data.bq_position = now;
                if (progressed >= 3) {
                    stopProgress();
                    clearTimeout(timer);
                    lastReport.status = 'Вбудований плеєр відтворює відео';
                    if (Date.now() - lastSaved >= 15000) { remember(data, true); lastSaved = Date.now(); }
                }
            }, videoRemovers);
            listen(video && video.listener, 'pause', function () { clearTimeout(timer); stopProgress(); }, videoRemovers);
            listen(video && video.listener, 'play', function () {
                if (progressed < 3 && owns(data)) showProgress('Запускаю відео…');
                arm(data);
            }, videoRemovers);
        }
        playlist.forEach(function (data) {
            data.error = function () { fail(data, 'Плеєр повідомив про помилку відтворення'); };
        });
        listen(player.listener, 'create', function (event) {
            var data = event && event.data;
            if (playlist.indexOf(data) >= 0) activate(data);
            else cleanup();
        }, removers);
        listen(player.listener, 'ready', function (data) {
            if (active && (!data || data === active || data.url === active.url)) {
                if (progressed < 3 && owns(active)) showProgress('Запускаю відео…');
                arm(active);
            }
        }, removers);
        listen(player.listener, 'external', function (data) {
            if (playlist.indexOf(data) < 0 || !current(requestId)) return;
            clearVideo(); external = true;
            stopProgress();
            remember(data, false);
            lastReport.status = 'Передано зовнішньому плеєру; відтворення й доріжку він не підтверджує';
        }, removers);
        listen(player.listener, 'destroy', function () {
            stopProgress();
            if (active && !failed && !external && progressed >= 3) remember(active, true);
            clearVideo(); active = null;
        }, removers);
        audioGuardCleanup = cleanup;
        return activate;
    }

    function playInTorrserve(item, card, onDead, opts) {
        var requestId = operation, ended = false;
        var season = curSeason, series = curIsSeries;
        var link = item.MagnetUri || item.Link;
        var title = card.title || card.name || '';
        opts = opts || {};
        function reject(error, retry) {
            if (ended || !current(requestId)) return;
            ended = true;
            error = typeof error === 'object' && error ? error : { message: String(error || 'Кандидат не підійшов'), reason: 'metadata' };
            if (onDead) onDead(retry || opts, error);
            else report(error.message);
        }
        if (!link) return reject('У релізу немає посилання');
        var required = requiredVoice();
        if (required && !releaseLanguages(item)[required]) return reject({ message: 'Реліз не підтверджує ' + voiceName(required) + ' озвучку', reason: 'language' });
        showProgress('Підключаю реліз до TorrServe…');
        tsApi({ action: 'add', link: link, title: title,
            poster: card.poster_path && Lampa.Api && Lampa.Api.img ? Lampa.Api.img(card.poster_path) : '',
            save_to_db: false
        }, function (torrent) {
            if (ended || !current(requestId)) return;
            var hash = torrent && torrent.hash;
            if (!hash) return reject('TorrServe не повернув хеш роздачі');
            showProgress('Отримую список відеофайлів…');
            waitFiles(hash, function (files) {
                if (ended || !current(requestId)) return;
                var videos = files.map(function (f, index) {
                    f = f || {};
                    return { path: String(f.path || ''), length: Math.max(0, Number(f.length) || 0),
                        id: f.id !== undefined && f.id !== null ? f.id : index + 1 };
                }).filter(function (f) {
                    return /\.(mkv|mp4|avi|ts|m4v|mov|webm|m2ts)$/i.test(f.path) &&
                        !/(^|[^a-zа-яіїєґ])(sample|семпл|trailer|трейлер)(?=$|[^a-zа-яіїєґ])/i.test(f.path);
                });
                if (!videos.length) return reject('У роздачі немає відеофайлу');
                if (series && season > 0) {
                    var selected = filesForSeason(videos, season, releaseSeasonText(item));
                    if (selected.wrong) return reject('Файли не підтверджують обраний сезон ' + season);
                    videos = selected.files;
                }
                if (!videos.length) return reject('У роздачі немає обраного сезону');
                if (!series) videos = [videos.sort(function (a, b) { return b.length - a.length; })[0]];
                else videos.sort(function (a, b) {
                    var difference = episodeOf(a.path) - episodeOf(b.path);
                    if (difference) return difference;
                    // ES5 comparison also works on older television browsers.
                    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
                });
                var playlist = videos.map(function (f, index) {
                    var episode = episodeOf(f.path);
                    var timelineKey = series && season && episode ? cardKey(card) + ':s' + season + ':e' + episode : hash + '_' + f.id;
                    var timeline;
                    try { timeline = Lampa.Timeline.view(timelineKey); } catch (e) { timeline = card.timeline; }
                    return { url: (serverAddress || tsUrl()) + '/stream/' + encodeURIComponent(baseName(f.path)) +
                        '?link=' + encodeURIComponent(hash) + '&index=' + encodeURIComponent(f.id) + '&play',
                        title: series ? baseName(f.path) : title, path: f.path, torrent_hash: hash,
                        timeline: timeline, quality: false, card: card, ffprobe: Array.isArray(item.ffprobe) ? item.ffprobe : undefined,
                        bq_episode: episode, bq_index: index, bq_position: 0 };
                });
                // No circular references: external players serialize this array.
                var externalPlaylist = playlist.map(function (data) {
                    return { url: data.url, title: data.title, path: data.path, torrent_hash: hash };
                });
                playlist.forEach(function (data) { data.playlist = externalPlaylist; });
                function playEpisode(index) {
                    if (ended || !current(requestId)) return;
                    if (!isFinite(index) || Math.floor(index) !== index || index < 0 || index >= playlist.length) return reject('Потрібної серії немає у цій роздачі');
                    var data = playlist[index];
                    if (opts.position > 0 && data.timeline && typeof data.timeline === 'object') {
                        data.timeline.time = opts.position;
                        data.bq_position = opts.position;
                    }
                    showProgress('Готую відео до запуску…');
                    warmUp(hash, data.url, function () {
                        if (ended || !current(requestId)) return;
                        var activate = watchPlayback(playlist, card, item, hash, season, function (retry, error) { reject(error, retry); });
                        activate(data);
                        showProgress('Запускаю відео…');
                        try {
                            Lampa.Player.play(data);
                            Lampa.Player.playlist(playlist);
                        } catch (e) {
                            if (audioGuardCleanup) audioGuardCleanup();
                            reject('Не вдалося запустити плеєр', { season: season, episode: data.bq_episode, path: data.path, hash: hash });
                        }
                    });
                }
                // Across releases an episode number is stable; its array index is not.
                if (series && (opts.episode || opts.path || opts.episodeIndex !== undefined)) {
                    var wanted = Number(opts.episode) || episodeOf(opts.path), chosen = -1;
                    for (var n = 0; n < playlist.length; n++) {
                        if (wanted ? playlist[n].bq_episode === wanted : opts.path && baseName(playlist[n].path) === baseName(opts.path)) { chosen = n; break; }
                    }
                    if (chosen < 0 && !wanted && !opts.path && opts.hash === hash) chosen = Number(opts.episodeIndex);
                    return playEpisode(chosen);
                }
                if (!series || playlist.length === 1) return playEpisode(0);
                stopProgress();
                Lampa.Select.show({ title: 'Яка серія?',
                    items: playlist.map(function (data, index) { return { title: escapeText(data.title), index: index }; }),
                    onSelect: function (selected) { Lampa.Controller.toggle('content'); playEpisode(selected.index); },
                    onBack: function () { if (current(requestId)) beginOperation(); Lampa.Controller.toggle('content'); }
                });
            }, reject);
        }, reject);
    }

    /* ---------- 4. Кнопка на картці фільму ---------- */

    function findBest(card, skipSaved, target) {
        var requestId = beginOperation();
        card = card || {};
        target = target || {};
        lastReport = { status: 'Пошук', found: 0, candidates: 0, tried: 0, reasons: {} };
        var title = String(card.title || card.name || '');
        var original = String(card.original_title || card.original_name || '');

        curRuntime = parseInt(card.runtime, 10) || 0;
        // Серіал: у картки є name/first_air_date замість title/release_date
        curIsSeries = isSeriesCard(card);
        curMaxSeason = parseInt(card.number_of_seasons, 10) || 0;
        curYear = parseInt(String(card.release_date || card.first_air_date || '').slice(0, 4), 10) || 0;

        // Знайомий серіал: пропонуємо продовжити з місця зупинки
        var saved = curIsSeries && !skipSaved ? contGet(card) : null;
        if (saved && saved.link) {
            Lampa.Select.show({
                title: (card.title || card.name),
                items: [
                    { title: '▶ Продовжити: ' + (saved.epTitle || ('сезон ' + saved.season)), act: 'resume' },
                    { title: 'Обрати інший сезон / серію', act: 'new' }
                ],
                onSelect: function (item) {
                    if (!current(requestId)) return;
                    Lampa.Controller.toggle('content');
                    if (item.act === 'resume') resumeSaved(saved);
                    else doSearch();
                },
                onBack: function () { if (current(requestId)) beginOperation(); Lampa.Controller.toggle('content'); }
            });
            return;
        }

        doSearch();

        function doSearch() {
            if (!current(requestId)) return;
            showProgress('Шукаю найкращий реліз…');
            var translated = {}, remaining = 2;
            ['ru', 'uk'].forEach(function (language) {
                localizedTitle(card, language, function (text) {
                    translated[language] = text;
                    if (--remaining === 0) runSearch(translated.ru, translated.uk);
                });
            });
        }

        function runSearch(ruTitle, ukTitle) {
            if (!current(requestId)) return;
            // Різні індексатори по-різному обробляють апострофи, тире та рік.
            // Тому формуємо кілька компактних варіантів, але без дублювання.
            var queries = [], querySeen = {};

            function addQuery(q) {
                q = String(q || '').replace(/\s+/g, ' ').trim();
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
            addQuery(ukTitle);
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
                    if (!i || !i.Title) return;
                    var magnetHash = (i.MagnetUri || '').match(/xt=urn:btih:([a-z0-9]+)/i);
                    var key = '$' + String(i.InfoHash || i.infohash || (magnetHash && magnetHash[1]) || i.MagnetUri || i.Link || i.Guid ||
                        (i.Title.toLowerCase() + '|' + i.Size)).toLowerCase();
                    if (seen[key]) {
                        var previous = seen[key];
                        previous.Seeders = Math.max(previous.Seeders, i.Seeders);
                        ['ffprobe', 'Audio', 'audio', 'audio_tracks', 'audioTracks', 'info', 'general'].forEach(function (field) {
                            if (!previous[field] || (Array.isArray(previous[field]) && !previous[field].length)) previous[field] = i[field];
                        });
                        return;
                    }
                    seen[key] = i;
                    merged.push(i);
                });
            }

            function done() {
                if (--pending > 0) return;
                lastReport.found = merged.length;
                if (!merged.length && failMsg) return report(failMsg, 'parser');
                route(merged, card, target);
            }

            if (!queries.length) return report('У картки немає назви для пошуку');
            // Не більше двох одночасних запитів; кожний має власний таймер.
            var next = 0;
            function launch() {
                if (next >= queries.length) return;
                var q = queries[next++], settled = false, cancel;
                var timer = setTimeout(function () {
                    if (typeof cancel === 'function') cancel();
                    settle([], 'Перевищено час очікування парсера');
                }, 15000);
                function settle(list, error) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (!current(requestId)) return;
                    if (error) failMsg = error;
                    add(list);
                    done();
                    launch();
                }
                try {
                    cancel = search(q, function (list) { settle(list); },
                        function (error) { settle([], error); });
                } catch (e) { settle([], 'Помилка запиту до парсера'); }
            }
            launch();
            launch();
        }
    }

    // Розводимо фільми та серіали
    function route(list, card, target) {
        var requestId = operation;
        target = target || {};
        if (!list.length) return report('Парсер не знайшов жодного релізу');

        curSeason = 0;

        if (!curIsSeries) return pick(list, card, target);

        // Серіал: дізнаємось, які сезони взагалі є в роздачах
        var seasons = extractSeasons(list);
        if (!seasons.length && curMaxSeason > 1) {
            for (var n = 1; n <= Math.min(curMaxSeason, 99); n++) seasons.push(n);
        }

        function go(season) {
            if (!current(requestId)) return;
            curSeason = season;
            var filtered = filterBySeason(list, season);

            if (!filtered.length) return report('Роздач сезону ' + season + ' не знайшлося');

            pick(filtered, card, target);
        }

        if (target.season > 0) return go(Number(target.season));

        if (seasons.length > 1) {
            stopProgress();
            Lampa.Select.show({
                title: 'Який сезон?',
                items: seasons.map(function (n) { return { title: 'Сезон ' + n, season: n }; }),
                onSelect: function (item) {
                    Lampa.Controller.toggle('content');
                    go(item.season);
                },
                onBack: function () { if (current(requestId)) beginOperation(); Lampa.Controller.toggle('content'); }
            });
        }
        else if (seasons.length === 1) go(seasons[0]);
        else {
            // Let file metadata confirm season one; never mix unlabelled seasons.
            go(1);
        }
    }

    // Номери сезонів, що згадуються в назвах роздач
    function extractSeasons(list) {
        var found = {};
        list.forEach(function (i) {
            seasonsOfText(releaseSeasonText(i)).forEach(function (n) { found[n] = true; });
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
            var marked = seasonsOfText(releaseSeasonText(i));
            return !marked.length || marked.indexOf(Number(season)) !== -1;
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
        if (/\b\d{1,3}\s+сер[иі]я(?=$|[^а-яіїєґ])/.test(t)) return true;
        return false;
    }

    function pick(list, card, target) {
        if (!list.length) return report('Роздач цього сезону не знайшлося');
        var voice = voiceMode(), required = requiredVoice(), maxGb = sizeLimit();
        var candidates = list.map(normalizeResult).filter(Boolean).filter(function (item) {
            delete item._why; delete item._relaxed;
            item._score = scoreRelease(item);
            if (!item.MagnetUri && !item.Link) item._why = 'link';
            if (!curIsSeries && maxGb > 0 && item.Size / 1073741824 > maxGb) item._why = 'size';
            var lang = releaseLanguages(item);
            if (required && !lang[required]) item._why = 'language';
            if (item._why) {
                lastReport.reasons[item._why] = (lastReport.reasons[item._why] || 0) + 1;
                return false;
            }
            item._language = voice === 'any' ? 0 : voice === 'rus' ?
                (lang.rus ? 0 : !lang.ukr ? 1 : 2) : lang.ukr ? 0 : lang.rus ? 1 : 2;
            item._compat = compatibilityRank(item);
            item._relaxed = !passesFilters(item);
            item._single = curIsSeries && isSingleEpisode(item.Title) ? 1 : 0;
            return true;
        });
        // Lexicographic priorities cannot be reversed by bitrate/seed bonuses.
        candidates.sort(function (a, b) {
            return a._language - b._language || a._compat - b._compat ||
                a._single - b._single || Number(a._relaxed) - Number(b._relaxed) || b._score - a._score;
        });
        lastReport.candidates = candidates.length;
        if (!candidates.length) {
            var why = lastReport.reasons;
            return report('Не підійшов жоден із ' + list.length + ' релізів. ' +
                (why.language ? 'Не підтверджено ' + voiceName(required) + ' озвучку: ' + why.language + '. ' : '') +
                (why.size ? 'Перевищують ліміт розміру: ' + why.size + '. ' : '') +
                (why.hdr ? 'HDR/DV відсіяно: ' + why.hdr + '. ' : '') +
                (why.link ? 'Немає посилання: ' + why.link + '. ' : '') +
                (!why.language && !why.size && !why.hdr && !why.link ? 'Перевір налаштування якості.' : ''));
        }
        tryCandidate(candidates, 0, card, target);
    }

    function tryCandidate(candidates, idx, card, opts) {
        var requestId = operation;
        if (idx >= candidates.length || idx >= 12) {
            return report('Перевірено ' + Math.min(idx, candidates.length) + ' кандидатів — запуск не підтверджено. ' +
                'Причини збережено в «Остання перевірка».');
        }
        var best = candidates[idx], settled = false;
        lastReport.tried++;
        lastReport.release = best.Title;
        showProgress((best._relaxed ? 'Запасна якість · ' : '') + 'Перевіряю ' + (idx + 1) + '/' + Math.min(candidates.length, 12) +
            ': ' + best.Title + ' · ' + best.Seeders + ' сідів');
        playInTorrserve(best, card, function (retryOpts, error) {
            if (settled || !current(requestId)) return;
            settled = true;
            error = error || {};
            var reason = error.reason || (error.terminal ? 'server' : 'metadata');
            lastReport.reasons[reason] = (lastReport.reasons[reason] || 0) + 1;
            if (error.terminal) return report(error.message || 'Перевір налаштування TorrServe');
            lastReport.lastFailure = error.message || 'Кандидат не підійшов';
            tryCandidate(candidates, idx + 1, card, retryOpts || opts);
        }, opts);
    }

    function addButton(e) {
        if (window.bq_version !== BQ_VERSION || !e || !e.object || !e.object.activity) return;
        var render = e.object.activity.render();

        function insert() {
            if (window.bq_version !== BQ_VERSION) return;
            // Прибираємо кнопку старої версії плагіна, якщо вона встигла з'явитися
            render.find('.view--bq').not('.view--bq-v' + BQ_VERSION).remove();

            var row = render.find('.full-start-new__buttons, .full-start__buttons').first();
            var playBtn = row.find('.button--play').first();

            // Кнопка вже стоїть у видимому ряду — все гаразд
            if (row.find('.view--bq-v' + BQ_VERSION).length) return true;

            var btn = $('<div class="full-start__button selector view--bq view--bq7 view--bq-v' + BQ_VERSION + '" role="button" aria-label="Дивитись">' +
                '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" stroke="none">' +
                '<path d="M13 2L4.5 13.5h5L9.5 22 18 10.5h-5L13 2z"/>' +
                '</svg>' +
                '<span>Дивитись</span></div>');

            btn.on('hover:enter', function () {
                if (window.bq_version === BQ_VERSION) findBest(e.data.movie);
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
        if (Lampa.SettingsApi.removeParams) Lampa.SettingsApi.removeParams('best_quality');
        Lampa.Storage.set(STORE.ukr, voiceMode());
        var selects = { tv: ['auto', 'fhd', 'uhd'], res: ['1080', '2160', 'any'],
            codec: ['auto', 'any', 'hevc', 'av1', 'avc'], hdr: ['auto', 'prefer', 'ignore', 'avoid'] };
        Object.keys(selects).forEach(function (key) {
            var value = cfg(key, selects[key][0]);
            if (selects[key].indexOf(value) < 0) value = selects[key][0];
            Lampa.Storage.set(STORE[key], value);
        });
        var maxgb = Lampa.Storage.get(STORE.maxgb, 'auto');
        var number = Number(String(maxgb).replace(',', '.'));
        if (maxgb === '' || maxgb === null || maxgb === undefined || maxgb === 'undefined' ||
            (maxgb !== 'auto' && (!isFinite(number) || number < 0))) {
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
            param: { name: STORE.ukr, type: 'select', values: { ukr: 'Українська (обов’язково)', ukr_rus: 'Українська → староукраїнська', rus: 'Староукраїнська', any: 'Байдуже' }, default: 'ukr' },
            field: { name: 'Мова озвучки', description: 'Українська та староукраїнська — обов’язкова обрана мова, без автоматичної підміни. Режим зі стрілкою дозволяє запасну мову. Байдуже — будь-яка. Зовнішній плеєр керує доріжками сам' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.ext, type: 'trigger', default: true },
            field: { name: 'Пріоритет розширених версій', description: 'Extended, Director\'s Cut, режисерська, Uncut, Unrated' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.res, type: 'select', values: { '2160': 'Перевага 4K', '1080': 'Перевага 1080p і вище', 'any': 'Будь-яка' }, default: '1080' },
            field: { name: 'Бажана роздільність', description: 'Якщо бажана якість не запускається, автоматично перевіряє нижчу. Обов’язкова українська та ліміт розміру зберігаються' }
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
            field: { name: 'Буферизація перед стартом', description: 'До 12 секунд попереднього завантаження. Зменшує ризик пауз на початку' }
        });

        Lampa.SettingsApi.addParam({
            component: 'best_quality',
            param: { name: STORE.seeds, type: 'input', values: '', default: '1', placeholder: '1' },
            field: { name: 'Бажаний мінімум сідів', description: 'Кількість у парсері може застаріти. За потреби перевіряє й роздачі з меншою кількістю' }
        });
        Lampa.SettingsApi.addParam({ component: 'best_quality', param: { name: 'bq_last_report', type: 'button' },
            field: { name: 'Остання перевірка', description: 'Стан пошуку, кількість кандидатів і причини відмов' },
            onRender: function (item) { item.on('hover:enter', function () {
                var names = { language: 'Мова', hdr: 'HDR/DV', size: 'Розмір', link: 'Немає посилання', cam: 'Екранка',
                    '3d': '3D', series: 'Серіал замість фільму', metadata: 'Метадані / сезон / файли', playback: 'Плеєр / аудіодоріжка', server: 'TorrServe', parser: 'Парсер' };
                var items = [{ title: escapeText(lastReport.status) },
                    { title: 'Знайдено: ' + lastReport.found + '; кандидатів: ' + lastReport.candidates + '; спроб: ' + lastReport.tried }];
                if (lastReport.release) items.push({ title: escapeText(lastReport.release) });
                if (lastReport.reconnects) items.push({ title: 'Повторних з’єднань із TorrServe: ' + lastReport.reconnects });
                Object.keys(lastReport.reasons).forEach(function (key) { items.push({ title: (names[key] || key) + ': ' + lastReport.reasons[key] }); });
                if (lastReport.lastFailure) items.push({ title: escapeText(lastReport.lastFailure) });
                Lampa.Select.show({ title: 'Перевірка · v' + BQ_VERSION, items: items, onSelect: function () {},
                    onBack: function () { Lampa.Controller.toggle('settings_component'); } });
            }); }
        });
        Lampa.SettingsApi.addParam({ component: 'best_quality', param: { name: 'bq_cancel', type: 'button' },
            field: { name: 'Зупинити автоматичний пошук' },
            onRender: function (item) { item.on('hover:enter', function () { beginOperation(); report('Автоматичний пошук зупинено'); }); }
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
                    title: escapeText((e.card.title || e.card.name) + ' · ' + (e.epTitle || ('сезон ' + e.season))),
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
        if (window.bq_version !== BQ_VERSION) return;
        attempt = attempt || 0;

        var list = $('.menu .menu__list').eq(0);

        // Меню може ще не намалюватися — пробуємо до 10 разів
        if (!list.length) {
            if (attempt < 10) setTimeout(function () { addMenuItem(attempt + 1); }, 500);
            return;
        }

        if (list.find('[data-action="bq_continue"]').length) {
            list.find('[data-action="bq_continue"]').off('hover:enter').on('hover:enter', showContinueList);
            return;
        }

        var icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

        var item = $('<li class="menu__item selector" data-action="bq_continue">' +
            '<div class="menu__ico">' + icon + '</div>' +
            '<div class="menu__text">Дивитись далі</div></li>');

        item.on('hover:enter', showContinueList);

        list.append(item);
    }

    /* ---------- Старт ---------- */

    var started = false;
    function onFull(e) { if (e.type === 'complite') addButton(e); }
    function onApp(e) { if (e.type === 'ready') start(); }
    function start() {
        if (started || window.bq_version !== BQ_VERSION) return;
        started = true;
        installDeviceStyles();
        addSettings();
        addDeviceSettings();
        addMenuItem();
        Lampa.Listener.follow('full', onFull);
        Lampa.Noty.show('«Дивитись» v' + BQ_VERSION + ' активний');
    }

    if (window.appready) start();
    else Lampa.Listener.follow('app', onApp);
})();
