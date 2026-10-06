'use strict';
// DOM integration only; the media player and network are intentionally simulated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const jquery = require('jquery');
const acorn = require('acorn');
const source = fs.readFileSync(path.join(__dirname, '..', 'b.js'), 'utf8');
const version = Number(source.match(/var BQ_VERSION = (\d+);/)[1]);
function bus() {
    const events = {};
    return {
        follow(name, fn) { (events[name] ||= new Set()).add(fn); },
        remove(name, fn) { events[name]?.delete(fn); },
        send(name, event) { for (const fn of [...(events[name] || [])]) fn(event); },
        count(name) { return events[name]?.size || 0; }
    };
}
function boot(ready = true) {
    const dom = new JSDOM('<!doctype html><head></head><body><div class="menu"><ul class="menu__list"></ul></div><div id="card"><div class="full-start-new__buttons"><div class="button--play">Native</div></div></div></body>', {runScripts:'outside-only', url:'https://lampa.invalid/'});
    const w = dom.window, $ = jquery(w), events = bus(), notices = [], settings = [], storage = {}, requests = [];
    const timers = new Map(); let clock = 0, nextId = 0, selection;
    w.setTimeout = (fn, delay) => { const id=++nextId;timers.set(id,{fn,at:clock+delay});return id; };
    w.clearTimeout = id => timers.delete(id);
    w.Date.now = () => clock;
    w.$ = $; w.appready = ready;
    w.Lampa = {
        Listener:events, SettingsApi:{removeParams(){settings.length=0;},addComponent(){},addParam(p){settings.push(p);}},
        Storage:{get:(key,def)=>key in storage?storage[key]:def,set:(key,value)=>{storage[key]=value;}},
        Controller:{collectionAppend(){},enabled:()=>({name:'full'}),toggle(){}},
        Noty:{show: text=>notices.push(text)}, Select:{show: data=>{selection=data;}},
        Reguest:function(){this.timeout=()=>{};this.clear=()=>{};this.native=(url,done,fail)=>{requests.push(url);fail({status:503});};},
        Torserver:{url:()=>''}, Api:{}, Player:{listener:bus()}, PlayerVideo:{listener:bus()}
    };
    w.eval(source);
    return {dom,w,$,events,notices,settings,storage,requests,selection:()=>selection,
        render(){events.send('full',{type:'complite',object:{activity:{render:()=>$('#card')}},data:{movie:{id:1,title:'Example'}}});},
        tick(ms){ const end=clock+ms;for(;;){const due=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);clock=due[1].at;due[1].fn();}clock=end; }
    };
}
test('published plugin remains valid ES5 for older television browsers',()=>{
    assert.doesNotThrow(()=>acorn.parse(source,{ecmaVersion:5}));
});
test('boot waits for Lampa ready and registers settings/menu once',()=>{
    const f=boot(false);assert.equal(f.settings.length,0);
    f.events.send('app',{type:'ready'});const count=f.settings.length;
    f.events.send('app',{type:'ready'});assert(count>10);assert.equal(f.settings.length,count);
    assert.equal(f.$('[data-action="bq_continue"]').length,1);f.dom.window.close();
});
test('full card button survives repeated renders and initiates automatic search',()=>{
    const f=boot();f.storage.jackett_url='https://parser.invalid';f.render();f.tick(2000);f.render();f.tick(2000);
    assert.equal(f.$('.view--bq').length,1);assert.equal(f.$('.button--play').text(),'Native');
    f.$('.view--bq').trigger('hover:enter');assert.equal(f.requests.length,1);assert(f.notices.some(text=>/парсер|Парсер/.test(text)));
    assert.equal(f.$('.bq-progress').length,0);
    f.dom.window.close();
});
test('legacy card layout and old button are upgraded without duplicate controls',()=>{
    const f=boot();f.$('#card').html('<div class="full-start__buttons"><div class="view--bq view--bq7">Old</div></div>');
    f.render();f.tick(2000);assert.equal(f.$('.view--bq').length,1);assert.match(f.$('.view--bq').text(),/Дивитись/);f.dom.window.close();
});
test('reloading same version cannot register duplicate listeners or settings',()=>{
    const f=boot();const count=f.settings.length;f.w.eval(source);
    assert.equal(f.settings.length,count);assert.equal(f.events.count('full'),1);assert.equal(f.$('[data-action="bq_continue"]').length,1);f.dom.window.close();
});
test('newer version disposes listeners, rebinds menu and replaces card action',()=>{
    const f=boot();f.render();f.tick(2000);
    f.w.eval(source.replace('var BQ_VERSION = '+version+';', 'var BQ_VERSION = '+(version+1)+';'));
    f.render();f.tick(2000);assert.equal(f.events.count('full'),1);assert.equal(f.$('.view--bq-v'+(version+1)).length,1);assert.equal(f.$('.view--bq-v'+version).length,0);
    f.$('[data-action="bq_continue"]').trigger('hover:enter');assert.match(f.notices.at(-1),/Поки/);f.dom.window.close();
});
test('device, connection, report and cancel settings are wired to actual controls',()=>{
    const f=boot();
    for(const name of ['bq_device_info','bq_connection_check','bq_last_report','bq_cancel']) {
        const param=f.settings.find(p=>p.param.name===name);assert(param,name);
        const element=f.$('<div></div>');param.onRender(element);element.trigger('hover:enter');
    }
    assert.match(f.notices.at(-1),/зупинено/);assert.match(f.selection().title,/Перевірка/);f.dom.window.close();
});

function playbackFlow(warm = false) {
    const f=boot(),parser=[],http=[],plays=[];let active;
    f.storage.bq_voice='any';f.storage.bq_warm=warm;
    f.w.Lampa.Parser={get(query,done,fail){parser.push({done,fail});}};
    f.w.Lampa.Torserver.url=()=> 'http://server.invalid';
    f.w.Lampa.Timeline={view:hash=>({hash,time:0})};
    f.w.XMLHttpRequest=function(){
        http.push(this);this.open=(method,url)=>{this.method=method;this.url=url;};this.setRequestHeader=(key)=>{if(key==='Range')this.probe=true;};
        this.getResponseHeader=()=>'video/x-matroska';
        this.send=()=>{if(this.probe){http.splice(http.indexOf(this),1);this.status=206;this.response={byteLength:65536};this.onload();}};this.abort=()=>{this.aborted=true;};
    };
    Object.assign(f.w.Lampa.Player,{
        play(data){f.w.Lampa.Player.listener.send('create',{data});active=data;plays.push(data);f.w.Lampa.Player.listener.send('ready',data);},
        playlist(){},playdata:()=>active,close(){f.w.Lampa.Player.listener.send('destroy');active=null;}
    });
    f.render();f.tick(400);f.$('.view--bq').trigger('hover:enter');
    return {...f,parser,http,plays,
        result(){parser[0].done([{Title:'Example 1080p',Link:'synthetic',Seeders:50}]);},
        respond(index,data){http[index].status=200;http[index].responseText=JSON.stringify(data);http[index].onload();},
        progress(){for(let t=0;t<=4;t++)f.w.Lampa.PlayerVideo.listener.send('timeupdate',{current:t,duration:100});}
    };
}
test('preparation status persists across long search, server, file and player phases',()=>{
    const f=playbackFlow();
    f.tick(5000);assert.equal(f.$('.bq-progress').length,1);assert.match(f.$('.bq-progress__text').text(),/Шукаю/);
    assert.equal(f.$('.bq-progress__time').text(),'5 с');
    f.result();f.tick(5000);assert.match(f.$('.bq-progress__text').text(),/TorrServe/);
    f.respond(0,{hash:'synthetic'});f.tick(5000);assert.match(f.$('.bq-progress__text').text(),/список відеофайлів/);
    f.respond(1,{file_stats:[{path:'Movie.mkv',id:1}]});f.tick(5000);assert.match(f.$('.bq-progress__text').text(),/Запускаю/);
    assert.equal(f.$('.bq-progress').length,1);assert.equal(f.$('.bq-progress__time').text(),'20 с');
    f.progress();assert.equal(f.$('.bq-progress').length,0);f.tick(5000);assert.equal(f.$('.bq-progress').length,0);f.dom.window.close();
});
test('buffer progress remains visible until readiness and preload is aborted at launch',()=>{
    const f=playbackFlow(true);f.result();f.respond(0,{hash:'synthetic'});f.respond(1,{file_stats:[{path:'Movie.mkv',id:1}]});
    f.respond(3,{preloaded_bytes:13,preload_size:100});f.tick(5000);
    assert.match(f.$('.bq-progress__text').text(),/Буферизація 13%/);assert.equal(f.plays.length,0);
    f.respond(4,{preloaded_bytes:60,preload_size:100});assert.equal(f.plays.length,1);assert(f.http[2].aborted);
    assert.match(f.$('.bq-progress__text').text(),/Запускаю/);f.progress();assert.equal(f.$('.bq-progress').length,0);f.dom.window.close();
});
test('reconnect status resumes the original phase after successful retry',()=>{
    const f=playbackFlow();f.result();f.http[0].onerror();assert.match(f.$('.bq-progress__text').text(),/Відновлюю зв’язок/);
    f.tick(800);f.respond(1,{hash:'synthetic'});assert.match(f.$('.bq-progress__text').text(),/список відеофайлів/);
    f.respond(2,{file_stats:[{path:'Movie.mkv',id:1}]});f.progress();assert.equal(f.$('.bq-progress').length,0);f.dom.window.close();
});
test('terminal errors and cancel button remove status with no zombie redraw',()=>{
    const f=playbackFlow();f.result();f.http[0].status=401;f.http[0].onload();
    assert.equal(f.$('.bq-progress').length,0);assert.match(f.notices.at(-1),/відхилив доступ/);f.tick(30000);assert.equal(f.$('.bq-progress').length,0);f.dom.window.close();
    const g=playbackFlow();const control=g.$('<div></div>');g.settings.find(p=>p.param.name==='bq_cancel').onRender(control);control.trigger('hover:enter');
    g.result();g.tick(30000);assert.equal(g.http.length,0);assert.equal(g.$('.bq-progress').length,0);g.dom.window.close();
});
test('manual pause and close hide startup status without retrying',()=>{
    const f=playbackFlow();f.result();f.respond(0,{hash:'synthetic'});f.respond(1,{file_stats:[{path:'Movie.mkv',id:1}]});
    f.w.Lampa.PlayerVideo.listener.send('pause');f.tick(30000);assert.equal(f.$('.bq-progress').length,0);assert.equal(f.http.length,2);
    f.w.Lampa.PlayerVideo.listener.send('play');assert.match(f.$('.bq-progress__text').text(),/Запускаю/);
    f.w.Lampa.Player.close();f.tick(30000);assert.equal(f.$('.bq-progress').length,0);assert.equal(f.http.length,2);f.dom.window.close();
});
test('external player handoff clears preparation status immediately',()=>{
    const f=playbackFlow();f.w.Lampa.Player.play=data=>f.w.Lampa.Player.listener.send('external',data);
    f.result();f.respond(0,{hash:'synthetic'});f.respond(1,{file_stats:[{path:'Movie.mkv',id:1}]});
    f.tick(30000);assert.equal(f.$('.bq-progress').length,0);assert.equal(f.http.length,2);f.dom.window.close();
});
test('version upgrade disposes in-progress UI and ignores old search completion',()=>{
    const f=playbackFlow();assert.equal(f.$('.bq-progress').length,1);
    f.w.eval(source.replace('var BQ_VERSION = '+version+';', 'var BQ_VERSION = '+(version+1)+';'));
    f.result();f.tick(30000);assert.equal(f.$('.bq-progress').length,0);assert.equal(f.http.length,0);f.dom.window.close();
});
test('season and episode dialogs pause the busy indicator until selection',()=>{
    const f=playbackFlow();
    // Render a series and replace the current movie search with its operation.
    f.$('#card .view--bq').remove();f.events.send('full',{type:'complite',object:{activity:{render:()=>f.$('#card')}},data:{movie:{id:42,name:'Example',number_of_seasons:2}}});
    f.tick(400);f.$('.view--bq').trigger('hover:enter');
    f.parser[1].done([{Title:'Example S01',Link:'first',Seeders:10},{Title:'Example S02',Link:'second',Seeders:10}]);
    assert.match(f.selection().title,/сезон/);assert.equal(f.$('.bq-progress').length,0);
    f.selection().onSelect({season:2});assert.equal(f.$('.bq-progress').length,1);
    f.respond(0,{hash:'synthetic'});f.respond(1,{file_stats:[{path:'Show.S02E01.mkv',id:1},{path:'Show.S02E02.mkv',id:2}]});
    assert.match(f.selection().title,/серія/);assert.equal(f.$('.bq-progress').length,0);
    f.selection().onSelect({index:1});assert.match(f.$('.bq-progress__text').text(),/Запускаю/);f.progress();f.dom.window.close();
});
