const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the actual card methods with a fake HA client and deterministic time.
// No network connections or physical-device commands are made by these tests.
const source = ts.transpileModule(readFileSync(path.join(__dirname, '../src/lg-remote-control.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
}).outputText;

function fixture(config = {}) {
    let now = 0;
    let id = 0;
    let Card;
    const tasks = new Map();
    const calls = [];
    // Normalize capture options: Node's EventTarget does not match the browser's
    // boolean-capture removeEventListener behavior on all supported Node versions.
    class BrowserEventTarget extends EventTarget {
        addEventListener(type, listener, options) {
            super.addEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options);
        }
        removeEventListener(type, listener, options) {
            super.removeEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options);
        }
    }
    const window = new BrowserEventTarget();
    const document = Object.assign(new BrowserEventTarget(), { hidden: false });
    const schedule = (fn, delay, repeat = false) => {
        tasks.set(++id, { fn, at: now + delay, delay, repeat });
        return id;
    };
    class LitElement extends EventTarget {
        connectedCallback() {}
        disconnectedCallback() {}
        requestUpdate() {}
    }
    const template = (strings, ...values) => ({ strings, values });
    const modules = {
        lit: { LitElement, css: template, html: template },
        'lit/decorators.js': { customElement: () => cls => { Card = cls; } },
        './const': { CARD_TAG_NAME: 'lg-remote-control', CARD_VERSION: 'test' },
        './editor': {},
        './icons': {},
        './utils': {},
    };
    vm.runInNewContext(source, {
        exports: {}, window, document, console: { info() {} },
        require: name => {
            assert.ok(name in modules, `Unexpected import: ${name}`);
            return modules[name];
        },
        setTimeout: (fn, delay) => schedule(fn, delay),
        setInterval: (fn, delay) => schedule(fn, delay, true),
        clearTimeout: handle => tasks.delete(handle),
        clearInterval: handle => tasks.delete(handle),
    });
    const card = new Card();
    card.hass = {
        states: { 'media_player.tv': { state: 'on', attributes: { sound_output: 'tv_speaker' } } },
        callService: (...args) => calls.push(JSON.parse(JSON.stringify(args))),
    };
    card.setConfig({ entity: 'media_player.tv', ...config });
    card.output_entity = 'media_player.tv';
    card.connectedCallback();
    function tick(ms) {
        const end = now + ms;
        for (;;) {
            const next = [...tasks].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            const [handle, task] = next;
            now = task.at;
            if (task.repeat) task.at += task.delay;
            else tasks.delete(handle);
            task.fn();
        }
        now = end;
    }
    function press(service = 'volume_up', extra = {}) {
        window.dispatchEvent(new Event('pointerdown'));
        card._startVolumeHold({ button: 0, isPrimary: true, ...extra }, service);
    }
    function click(service = 'volume_up', detail = 1) {
        card._volumeClick({ button: 0, detail }, service);
    }
    return { card, window, document, tasks, calls, tick, press, click };
}

for (const service of ['volume_up', 'volume_down']) {
    for (const config of [{}, { volume_hold: false }, { volume_hold: 'true' }]) {
        test(`${service}: only boolean true can opt into repeat (${JSON.stringify(config)})`, () => {
            const f = fixture(config);
            f.press(service);
            f.tick(20000);
            assert.equal(f.calls.length, 0);
            f.window.dispatchEvent(new Event('pointerup'));
            f.click(service);
            f.tick(20000);
            assert.deepEqual(f.calls, [['media_player', service, { entity_id: 'media_player.tv' }]]);
        });
    }

    test(`${service}: short click sends one step even with repeat enabled`, () => {
        const f = fixture({ volume_hold: true });
        f.press(service);
        f.tick(100);
        f.window.dispatchEvent(new Event('pointerup'));
        f.click(service);
        f.tick(5000);
        assert.equal(f.calls.length, 1);
    });

    test(`${service}: long press stops on outside release, without an extra click step`, () => {
        const f = fixture({ volume_hold: true });
        f.press(service);
        f.tick(800);
        assert.ok(f.calls.length >= 3);
        const count = f.calls.length;
        f.window.dispatchEvent(new Event('pointerup'));
        f.click(service);
        f.tick(20000);
        assert.equal(f.calls.length, count);
        f.press(service);
        f.window.dispatchEvent(new Event('pointerup'));
        f.click(service);
        assert.equal(f.calls.length, count + 1);
    });
}

for (const cancellation of ['pointercancel', 'pointerdown', 'keydown', 'blur', 'hidden', 'leave', 'disconnect', 'config', 'output']) {
    for (const delay of [100, 800]) {
        test(`${cancellation}: cancels a ${delay < 500 ? 'pending' : 'repeating'} hold`, () => {
            const f = fixture({ volume_hold: true });
            f.press();
            f.tick(delay);
            const count = f.calls.length;
            if (cancellation === 'hidden') {
                f.document.hidden = true;
                f.document.dispatchEvent(new Event('visibilitychange'));
            } else if (cancellation === 'leave') f.card.cancelVolumeHold();
            else if (cancellation === 'disconnect') f.card.disconnectedCallback();
            else if (cancellation === 'config') f.card.setConfig({ entity: 'media_player.tv', volume_hold: false });
            else if (cancellation === 'output') f.card.updated(new Map([['hass', null]]));
            else f.window.dispatchEvent(new Event(cancellation));
            f.tick(20000);
            assert.equal(f.calls.length, count);
        });
    }
}

test('switching plus to minus clears the previous repeat timer', () => {
    const f = fixture({ volume_hold: true });
    f.press();
    f.tick(800);
    const count = f.calls.length;
    f.press('volume_down');
    f.tick(800);
    assert.ok(f.calls.length > count);
    assert.ok(f.calls.slice(count).every(call => call[1] === 'volume_down'));
});

test('pressing + again cannot orphan the previous repeating timer', () => {
    const f = fixture({ volume_hold: true });
    f.press();
    f.tick(800);
    const count = f.calls.length;
    // Simulate the lost release from issue #180, then press the same key again.
    f.press();
    f.tick(100);
    f.window.dispatchEvent(new Event('pointerup'));
    f.click();
    f.tick(20000);
    assert.equal(f.calls.length, count + 1);
});

test('turning the TV off cancels repeat even if sound_output is unchanged', () => {
    const f = fixture({ volume_hold: true });
    f.card.soundOutput = 'tv_speaker';
    f.press();
    f.tick(800);
    const count = f.calls.length;
    f.card.hass.states['media_player.tv'].state = 'off';
    f.card.updated(new Map([['hass', null]]));
    f.tick(20000);
    assert.equal(f.calls.length, count);
});

test('receiver routing retains the slower 250ms repeat interval', () => {
    const f = fixture({ volume_hold: true, ampli_entity: 'media_player.receiver' });
    f.card.output_entity = 'media_player.receiver';
    f.press();
    f.tick(749);
    assert.equal(f.calls.length, 1);
    f.tick(1);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0][2].entity_id, 'media_player.receiver');
});

test('custom VOLUME_UP service override is preserved', () => {
    const f = fixture({ keys: { VOLUME_UP: { service: 'script.safe_volume', data: { step: 1 } } } });
    f.click();
    assert.deepEqual(f.calls, [['script', 'safe_volume', { step: 1 }]]);
});

test('keyboard activation is not swallowed after a cancelled mouse hold', () => {
    const f = fixture({ volume_hold: true });
    f.press();
    f.tick(800);
    f.window.dispatchEvent(new Event('blur'));
    const count = f.calls.length;
    f.click('volume_up', 0);
    assert.equal(f.calls.length, count + 1);
});

test('secondary/non-primary pointers cannot start repeating', () => {
    const f = fixture({ volume_hold: true });
    f.press('volume_up', { button: 2 });
    f.tick(5000);
    f.press('volume_up', { isPrimary: false });
    f.tick(5000);
    assert.equal(f.calls.length, 0);
});

test('disconnect removes global listeners and all timers; reconnect still works', () => {
    const f = fixture({ volume_hold: true });
    f.press();
    f.card.disconnectedCallback();
    assert.equal(f.tasks.size, 0);
    f.window.dispatchEvent(new Event('pointerdown'));
    f.document.hidden = true;
    f.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(f.tasks.size, 0);
    f.card.connectedCallback();
    f.press();
    f.tick(800);
    assert.ok(f.calls.length > 0);
    const count = f.calls.length;
    f.window.dispatchEvent(new Event('pointerup'));
    f.tick(5000);
    assert.equal(f.calls.length, count);
});
