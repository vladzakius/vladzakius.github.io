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
    f.$('.view--bq').trigger('hover:enter');assert.equal(f.requests.length,1);assert(f.notices.some(text=>/Шукаю/.test(text)));
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
    f.w.eval(source.replace('var BQ_VERSION = 39;', 'var BQ_VERSION = 40;'));
    f.render();f.tick(2000);assert.equal(f.events.count('full'),1);assert.equal(f.$('.view--bq-v40').length,1);assert.equal(f.$('.view--bq-v39').length,0);
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
