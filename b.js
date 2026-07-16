(function () {
    'use strict';

    var BQ_VERSION = 21;

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
        ukr:    'bq_ukr',      // бонус за українську озвучку
        warm:   'bq_warm',     // буферизація перед стартом
        cont:   'bq_continue'  // пам'ять «дивитись далі»
    };

    function cfg(key, def) {
        var v = Lampa.Storage.get(STORE[key], def);
        return v === '' || v === undefined ? def : v;
    }

    // Тривалість поточного фільму в хвилинах — для розрахунку бітрейту
    var curRuntime = 0;
    // Серіал: інша логіка розміру, вибір сезону і серії
    var curIsSeries = false;
    var curMaxSeason = 0;
    var curSeason = 0;
    var curYear = 0;

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

        // 3D-релізи: на звичайному ТБ дають подвійну картинку
        if (/\b3d\b|half.?sbs|\bh?sbs\b|half.?ou|\bh?ou\b|side.?by.?side|over.?under|стерео\s?пар/.test(t)) return -1;

        // Картка — ФІЛЬМ: серіальні роздачі з тією ж назвою не пропускаємо
        // (напр., фільм «Джентльмени» 2019 vs серіал «Джентльмени» 2024)
        if (!curIsSeries) {
            if (/\bs\d{1,2}(?:e\d{1,3})?\b|сезон[\s.:№]*\d|\d[\s.\-]*(?:й|-й)?\s*сезон|сери[иія][\s.:№]*\d|\b\d{1,2}x\d{2}\b|complete\s+series/.test(t)) return -1;

            // Рік у назві сильно розходиться з роком фільму — це інший твір
            if (curYear) {
                var years = t.match(/\b(?:19|20)\d{2}\b/g);
                if (years && !years.some(function (y) { return Math.abs(parseInt(y, 10) - curYear) <= 1; })) return -1;
            }
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

        // Українська озвучка; повний дубляж цінніший за закадровий
        var ukrOn = cfg('ukr', 'true');
        if (ukrOn === true || ukrOn === 'true') {
            if (/ukr|укр/.test(t))      score += 100;
            if (/дубляж|\bdub\b/.test(t)) score += 60;
        }

        // Точний збіг обраного сезону цінніший за багатосезонний пак
        if (curIsSeries && curSeason > 0) {
            var reExact = new RegExp('\\bs0?' + curSeason + '(?:e\\d|\\b)|сезон[\\s.:№]*0?' + curSeason + '\\b|\\b0?' + curSeason + '[\\s.\\-]*(?:й|-й)?\\s*сезон');
            if (reExact.test(t)) score += 80;
        }

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

        return score;
    }

    function passesFilters(item) {
        var t = (item.Title || '').toLowerCase();
        var sizeGb = (item.Size || 0) / 1073741824;
        var maxGb = parseFloat(cfg('maxgb', tvMode() === 'uhd' ? 80 : 30)) || 0;
        var minSeeds = parseInt(cfg('seeds', 1), 10) || 0;
        var minRes = cfg('res', '1080');

        if ((item.Seeders || 0) < minSeeds) return false;
        if (!curIsSeries && maxGb > 0 && sizeGb > maxGb) return false;

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

    // Які сезони реально лежать у файлах роздачі та чи є там обраний
    function filesForSeason(videos, season) {
        function seasonsOf(path) {
            var p = path.toLowerCase();
            var out = {}, m;
            var re1 = /s(\d{1,2})e\d/g;
            while ((m = re1.exec(p))) out[parseInt(m[1], 10)] = true;
            var re2 = /\b(\d{1,2})x\d{2}\b/g;
            while ((m = re2.exec(p))) out[parseInt(m[1], 10)] = true;
            var re3 = /(?:season|сезон)[\s._:№-]*(\d{1,2})/g;
            while ((m = re3.exec(p))) out[parseInt(m[1], 10)] = true;
            return Object.keys(out).map(Number);
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

        var finished = false;
        var t0 = Date.now();
        var lastPre = -1, stallAt = Date.now();

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
            try { xhr.abort(); } catch (e) {}
            done();
        }

        (function poll() {
            if (finished) return;
            // Жорстка стеля 12 с — краще легкий фриз на старті, ніж довге чекання
            if (Date.now() - t0 > 12000) return finish();

            tsApi({ action: 'get', hash: hash }, function (t) {
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
                var videos = files.filter(function (f) {
                    if (!/\.(mkv|mp4|avi|ts|m4v|mov)$/i.test(f.path)) return false;
                    // Семпли й трейлери в паках ламають плеєр
                    if (/\b(sample|семпл|trailer|трейлер)\b/i.test(f.path)) return false;
                    return true;
                });

                if (!videos.length) {
                    tsApi({ action: 'rem', hash: hash }, function () {}, function () {});
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

                // Фільм або одиночний файл — граємо одразу
                if (!curIsSeries || videos.length === 1) {
                    var video = videos.sort(function (a, b) { return b.length - a.length; })[0];
                    var mUrl = streamOf(video, 0);

                    if (curIsSeries) contSave(card, {
                        season: curSeason, epIndex: 0,
                        epTitle: video.path.split('/').pop(), link: link
                    });

                    warmUp(hash, mUrl, function () {
                        Lampa.Player.play({ url: mUrl, title: title, timeline: timelineOf(video), quality: false });
                        Lampa.Player.playlist([{ url: mUrl, title: title }]);
                    });
                    return;
                }

                // Серіал: якщо пак не містить обраного сезону — це не наш пак
                if (curSeason > 0) {
                    var sel = filesForSeason(videos, curSeason);

                    if (sel.wrong) {
                        tsApi({ action: 'rem', hash: hash }, function () {}, function () {});
                        Lampa.Noty.show('У цій роздачі лише сезон ' + sel.wrong.join(', ') + ' — шукаю далі…');
                        if (onDead) return onDead();
                        return;
                    }

                    videos = sel.files;
                }

                // Серіал: серії за номерами, вибір + плейлист
                videos.sort(function (a, b) {
                    return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
                });

                var playlist = videos.map(function (f, i) {
                    return { url: streamOf(f, i), title: f.path.split('/').pop(), timeline: timelineOf(f) };
                });

                function playEpisode(idx) {
                    idx = Math.max(0, Math.min(idx, playlist.length - 1));

                    contSave(card, {
                        season: curSeason, epIndex: idx,
                        epTitle: playlist[idx].title, link: link
                    });

                    warmUp(hash, playlist[idx].url, function () {
                        Lampa.Player.play({
                            url: playlist[idx].url,
                            title: playlist[idx].title,
                            timeline: playlist[idx].timeline,
                            playlist: playlist,
                            quality: false
                        });
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
        // Серіал: у картки є name/first_air_date замість title/release_date
        curIsSeries = !!(card.first_air_date || (card.name && !card.title));
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

        search(title, function (list) {
            if (!list.length && original && original !== title) {
                search(original, function (list2) { route(list2, card); },
                    function (m) { Lampa.Noty.show(m); });
            }
            else route(list, card);
        }, function (msg) {
            Lampa.Noty.show(msg);
        });

        }
    }

    // Розводимо фільми та серіали
    function route(list, card) {
        if (!list.length) return Lampa.Noty.show('Парсер не знайшов жодного релізу');

        curSeason = 0;

        if (!curIsSeries) return pick(list, card);

        // Серіал: дізнаємось, які сезони взагалі є в роздачах
        var seasons = extractSeasons(list);

        function go(season) {
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
            var t = (i.Title || '').toLowerCase();
            var m;

            var reS = /\bs(\d{1,2})(?:e\d|\b)/g;                 // S02, S02E05
            while ((m = reS.exec(t))) found[parseInt(m[1], 10)] = true;

            var reU = /сезон[\s.:№]*(\d{1,2})/g;                  // сезон 2
            while ((m = reU.exec(t))) found[parseInt(m[1], 10)] = true;

            var reU2 = /(\d{1,2})[\s.\-]*(?:й|-й)?\s*сезон/g;     // 2 сезон, 2-й сезон
            while ((m = reU2.exec(t))) found[parseInt(m[1], 10)] = true;

            // Діапазони — лише явно сезонні: S01-S05 або «сезоны 1-5»
            // (інакше «Серии: 1-9» перетворюються на фантомні сезони)
            var reR1 = /\bs(\d{1,2})\s*[-–]\s*s?(\d{1,2})/g;
            var reR2 = /сезон[иы]?[\s.:№]*(\d{1,2})\s*[-–]\s*(\d{1,2})/g;
            [reR1, reR2].forEach(function (re) {
                while ((m = re.exec(t))) {
                    var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
                    if (a > 0 && b >= a && b < 60) for (var n = a; n <= b; n++) found[n] = true;
                }
            });
        });

        return Object.keys(found).map(Number).filter(function (n) {
            if (n <= 0 || n >= 60) return false;
            if (curMaxSeason > 0 && n > curMaxSeason) return false;
            return true;
        }).sort(function (a, b) { return a - b; });
    }

    // Роздачі потрібного сезону, включно з діапазонами (сезони 1-5, S01-S05)
    function filterBySeason(list, season) {
        var out = list.filter(function (i) {
            var t = (i.Title || '').toLowerCase();

            var re = new RegExp('\\bs0?' + season + '(?:e\\d|\\b)|сезон[\\s.:№]*0?' + season + '\\b|\\b0?' + season + '[\\s.\\-]*(?:й|-й)?\\s*сезон');
            if (re.test(t)) return true;

            // Діапазон — лише явно сезонний: S01-S05 чи «сезоны 1-5»
            var m = t.match(/\bs(\d{1,2})\s*[-–]\s*s?(\d{1,2})/) ||
                    t.match(/сезон[иы]?[\s.:№]*(\d{1,2})\s*[-–]\s*(\d{1,2})/);
            if (m) {
                var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
                if (a <= season && season <= b && b < 60) return true;
            }

            return false;
        });

        return out;
    }

    // Односерійний реліз: S03E05 (без діапазону), «Серия 5»
    function isSingleEpisode(title) {
        var t = (title || '').toLowerCase();
        if (/\bs\d{1,2}e\d{1,3}\b(?!\s*[-–—]\s*e?\d)/.test(t) && !/\be\d{1,3}\s*[-–—]\s*e?\d/.test(t)) return true;
        if (/серия[\s.:№]*\d/.test(t) && !/серии/.test(t)) return true;
        return false;
    }

    function pick(list, card) {
        if (!list.length) return Lampa.Noty.show('Роздач цього сезону не знайшлося');

        var scored = list
            .map(function (i) { i._score = scoreRelease(i); return i; })
            .filter(function (i) { return i._score > 0; })
            .sort(function (a, b) { return b._score - a._score; });

        // Серіал: сезонні паки важливіші за односерійні релізи —
        // інакше свіжа серія онгоінга з тисячами сідів «з'їдає» вибір серії
        if (curIsSeries) {
            var packs = scored.filter(function (i) { return !isSingleEpisode(i.Title); });
            if (packs.length) scored = packs;
        }

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

        function insert() {
            // Прибираємо кнопку старої версії плагіна, якщо вона встигла з'явитися
            render.find('.view--bq').not('.view--bq7').remove();

            var row = render.find('.full-start-new__buttons, .full-start__buttons').first();
            var playBtn = row.find('.button--play').first();

            // Кнопка вже стоїть у видимому ряду — все гаразд
            if (row.find('.view--bq7').length) return true;

            var btn = $('<div class="full-start__button selector view--bq view--bq7">' +
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

    function start() {
        addSettings();
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
