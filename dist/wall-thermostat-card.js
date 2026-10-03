// wall-thermostat-card: a thermostat dial for ONE climate entity, for any Home Assistant dashboard.
// Target temperature (drag, tap or step), current temperature, hvac mode and fan mode. Plain JS, no build step.
// The dial geometry, the tap and drag rules and the send logic are wall-horizon-lib.js's, shared with
// wall-horizon-card's thermostat sheet; this file is the card around them.

const VERSION = new URL(import.meta.url).search;
// The lib is fetched with this module's own ?v=, so one update busts both caches.
const {
  CLIMATE_DEBOUNCE_MS, DIAL, arcPath, climateDue, climateInit, climateStep, climateToast, dialAngle, dialDrag, dialPoint, dialTap,
  esc, fillPath, fromUnits, num, thermostatCall, thermostatView, tickPath, toUnits, STEP_MINUS, STEP_PLUS,
} = await import(new URL(`wall-horizon-lib.js${VERSION}`, import.meta.url).href);

const FIELDS = ['temp', 'mode', 'fan'];
// The SVG is drawn with a margin around the dial's 460-unit square, so the handle and the glow stay inside the card.
const PAD = 44;
const BOX = DIAL.size + 2 * PAD;
const MAX_TICKS = 60; // more steps than this and the tick marks would merge: none are drawn
const MESSAGE_MS = 4000;

const CSS = `
  :host { display: block; }
  ha-card { display: block; overflow: hidden; }
  .wrap { padding: 16px; color: var(--primary-text-color, #e8ecf3); user-select: none; -webkit-user-select: none; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-height: 24px; }
  .name { font-size: 18px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .msg { font-size: 13px; color: var(--error-color, #db4437); white-space: nowrap; }
  .dial { position: relative; width: min(100%, 340px); aspect-ratio: 1; margin: 4px auto 0; container-type: inline-size; --mc: #9aa3b2; }
  .dial svg { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; outline: none; }
  .dial svg:focus-visible .d-track { stroke: var(--primary-color, #03a9f4); stroke-opacity: .5; }
  .d-track { fill: none; stroke: var(--divider-color, rgb(127 127 127 / .3)); stroke-width: 30; stroke-linecap: round; }
  .d-ticks { fill: none; stroke: var(--secondary-text-color, #9aa3b2); stroke-opacity: .6; stroke-width: 2; }
  .d-glow { fill: none; stroke: var(--mc); stroke-width: 54; stroke-linecap: round; opacity: .18; }
  .d-fill { fill: none; stroke: var(--mc); stroke-width: 30; stroke-linecap: round; }
  .d-now { fill: var(--primary-text-color, #fff); opacity: .85; }
  .d-end { fill: var(--secondary-text-color, #9aa3b2); font-size: 20px; font-weight: 600; text-anchor: middle; }
  .d-knob { fill: #fff; stroke: rgb(0 0 0 / .35); stroke-width: 4; }
  .d-ring { fill: none; stroke: var(--mc); stroke-width: 4; }
  .d-ring.sending { opacity: .35; animation: breathe .9s ease-in-out infinite alternate; }
  @keyframes breathe { from { opacity: .9; } to { opacity: .25; } }
  .dial[data-live="false"] svg { opacity: .5; }
  .num { position: absolute; left: 0; right: 0; top: 29%; text-align: center; font-size: 27cqw; font-weight: 600; line-height: 1;
    letter-spacing: -.02em; pointer-events: none; }
  .num.room { opacity: .45; }
  .status { position: absolute; left: 12%; right: 12%; top: 59%; text-align: center; font-size: 5.4cqw; font-weight: 500; line-height: 1.15;
    color: var(--mc); pointer-events: none; }
  .steps { position: absolute; left: 0; right: 0; bottom: 3%; display: flex; justify-content: center; gap: 7cqw; }
  button { appearance: none; font: inherit; color: inherit; margin: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  button:disabled { cursor: default; opacity: .4; }
  button:focus-visible { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px; }
  .step { width: 15cqw; height: 15cqw; min-width: 36px; min-height: 36px; padding: 0; border-radius: 50%; background: transparent;
    border: 1.5px solid var(--divider-color, rgb(127 127 127 / .4)); font-size: 9cqw; line-height: 1; display: flex; align-items: center; justify-content: center; }
  .step svg { position: static; inset: auto; width: 55%; height: 55%; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; }
  .lbl { margin: 14px 0 6px; font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--secondary-text-color, #9aa3b2); }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { position: relative; display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 999px; background: transparent;
    border: 1px solid var(--divider-color, rgb(127 127 127 / .4)); font-size: 14px; line-height: 1.2; }
  .chip i { width: 9px; height: 9px; border-radius: 50%; background: var(--c); }
  .chip[aria-pressed="true"] { border-color: var(--c); background: color-mix(in srgb, var(--c) 22%, transparent); font-weight: 600; }
  .chip[data-pending] { animation: breathe .9s ease-in-out infinite alternate; }
  [hidden] { display: none !important; }
  @media (prefers-reduced-motion: reduce) { .d-ring.sending, .chip[data-pending] { animation: none; } }
`;

const TEMPLATE = `
  <ha-card>
    <div class="wrap">
      <div class="head"><span class="name" id="name"></span><span class="msg" id="msg" role="status"></span></div>
      <div class="dial" id="dial">
        <svg id="svg" viewBox="${-PAD} ${-PAD} ${BOX} ${BOX}" tabindex="0" role="slider" aria-label="Target temperature">
          <path class="d-track" id="track"></path>
          <path class="d-ticks" id="ticks"></path>
          <path class="d-glow" id="glow"></path>
          <path class="d-fill" id="fill"></path>
          <circle class="d-now" id="now" r="7"></circle>
          <text class="d-end" id="min"></text><text class="d-end" id="max"></text>
          <g id="handle"><circle class="d-ring" id="ring" r="36"></circle><circle class="d-knob" r="28"></circle></g>
        </svg>
        <div class="num" id="num"></div>
        <div class="status" id="status"></div>
        <div class="steps">
          <button type="button" class="step" data-act="step" data-d="-1" aria-label="Lower the target">${STEP_MINUS}</button>
          <button type="button" class="step" data-act="step" data-d="1" aria-label="Raise the target">${STEP_PLUS}</button>
        </div>
      </div>
      <div id="modeBox"><div class="lbl">Mode</div><div class="chips" id="modes"></div></div>
      <div id="fanBox"><div class="lbl">Fan</div><div class="chips" id="fans"></div></div>
    </div>
  </ha-card>`;

const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};
const setHTML = (el, html) => {
  if (el.__html !== html) {
    el.__html = html;
    el.innerHTML = html;
  }
};

// Node can import this file to check its config handling; there it has no DOM.
class WallThermostatCard extends (globalThis.HTMLElement ?? class {}) {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._f = null; // the three fields' send state (wall-horizon-lib climateStep), once the entity has been seen
    this._drag = null;
    this.shadowRoot.addEventListener('click', (e) => this._onClick(e));
  }

  static getStubConfig(hass) {
    const first = Object.keys(hass?.states || {}).find((id) => id.startsWith('climate.'));
    return { entity: first || 'climate.thermostat' };
  }

  setConfig(config) {
    if (!config || typeof config.entity !== 'string' || !config.entity) throw new Error('wall-thermostat-card: entity is required (one climate entity)');
    if (!config.entity.startsWith('climate.')) throw new Error('wall-thermostat-card: entity must be a climate entity');
    const changed = this._config?.entity !== config.entity;
    this._config = { entity: config.entity, name: typeof config.name === 'string' ? config.name : '' };
    if (changed) {
      // Another entity: nothing waiting for the old one is sent to the new one.
      clearTimeout(this._timer);
      this._f = null;
      this._so = undefined;
      this._drag = null;
    }
    if (this._hass) this._feed(this._hass.states[this._config.entity]);
    if (this.isConnected) this._build();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._feed(hass.states[this._config.entity]);
    this._render();
  }

  getCardSize() {
    return 7;
  }

  connectedCallback() {
    if (!this._config) return;
    this._build();
    this._schedule();
  }

  /** Leaving the page sends a setpoint still waiting out its debounce, as closing Horizon's sheet does. */
  disconnectedCallback() {
    this._drag = null;
    if (this._f) this._step('temp', { type: 'flush' });
    clearTimeout(this._timer);
    this._timer = null;
    clearTimeout(this._msgTimer);
  }

  _build() {
    if (!this._el) {
      this.shadowRoot.innerHTML = `<style>${CSS}</style>${TEMPLATE}`;
      this._el = {};
      for (const id of ['name', 'msg', 'dial', 'svg', 'track', 'ticks', 'glow', 'fill', 'now', 'min', 'max', 'handle', 'ring', 'num', 'status', 'modeBox', 'modes', 'fanBox', 'fans']) this._el[id] = this.shadowRoot.getElementById(id);
      this._el.steps = [...this.shadowRoot.querySelectorAll('.step')];
      this._el.track.setAttribute('d', arcPath(-135, 135));
      const svg = this._el.svg;
      svg.addEventListener('pointerdown', (e) => this._onPointerDown(e));
      // lostpointercapture ends a drag like pointerup: a touch screen can drop a finger's pointerup.
      for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) svg.addEventListener(type, (e) => this._onDrag(e));
      svg.addEventListener('keydown', (e) => this._onKey(e));
    }
    this._render();
  }

  // ---- state ------------------------------------------------------------------------------------

  /** The entity's state object into the three fields, once per change (HA replaces the object when it changes). */
  _feed(so) {
    if (this._f && so === this._so) return;
    this._so = so;
    const ok = !!so && so.state !== 'unavailable' && so.state !== 'unknown';
    const vals = { temp: ok ? num(so.attributes?.temperature) : null, mode: so?.state ?? null, fan: so?.attributes?.fan_mode ?? null };
    if (!this._f) {
      this._f = { temp: climateInit(vals.temp, CLIMATE_DEBOUNCE_MS), mode: climateInit(vals.mode), fan: climateInit(vals.fan) };
      return;
    }
    for (const f of FIELDS) this._step(f, { type: 'entity', value: vals[f] });
  }

  /** What the card shows: the entity, with the values the user has just chosen in place until it confirms them. */
  _view() {
    const so = this._so;
    const ok = !!so && so.state !== 'unavailable' && so.state !== 'unknown';
    const f = this._f;
    const shown = ok && f ? { ...so, state: f.mode.shown ?? so.state, attributes: { ...so.attributes, temperature: f.temp.shown, fan_mode: f.fan.shown } } : so;
    return thermostatView(shown, this._hass?.config?.unit_system?.temperature);
  }

  /** One event through one field: a send, a failure message, and the next tick. The caller renders. */
  _step(field, ev) {
    const { state, send, toast } = climateStep(this._f[field], ev, Date.now());
    this._f[field] = state;
    if (send) this._send(field, send);
    if (toast) this._message(climateToast(this._name()));
    this._schedule();
  }

  /** The only place this card calls a service: one of three climate services, on the configured entity. */
  _send(field, { value, run }) {
    Promise.resolve()
      .then(() => this._hass.callService(...thermostatCall(this._config.entity, field, value)))
      .catch((err) => {
        console.warn(`wall-thermostat-card: ${field} was not accepted`, err);
        if (!this._f) return;
        this._step(field, { type: 'error', run });
        this._render();
      });
  }

  /** One timer: the earliest debounce end or confirmation timeout among the three fields. */
  _schedule() {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this._f || !this.isConnected) return;
    let due = null;
    for (const f of FIELDS) {
      const d = climateDue(this._f[f]);
      if (d !== null && (due === null || d < due)) due = d;
    }
    if (due !== null) this._timer = setTimeout(() => this._tick(), Math.max(0, due - Date.now()));
  }

  _tick() {
    this._timer = null;
    for (const f of FIELDS) this._step(f, { type: 'tick' });
    this._render();
  }

  _name() {
    return this._config.name || this._so?.attributes?.friendly_name || this._config.entity;
  }

  _message(text) {
    if (!this._el) return;
    setText(this._el.msg, text);
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => this._el && setText(this._el.msg, ''), MESSAGE_MS);
  }

  // ---- input ------------------------------------------------------------------------------------

  /** A new target in dial units (steps), clamped to the range. */
  _setUnits(u, v) {
    const clamped = Math.min(v.range.max, Math.max(v.range.min, u));
    const value = fromUnits(clamped, v.step, v.digits);
    if (value === v.target) return false;
    this._step('temp', { type: 'input', value });
    return true;
  }

  _onClick(e) {
    const el = e.target.closest?.('[data-act]');
    if (!el || el.disabled || !this._hass || !this._f) return;
    const v = this._view();
    if (el.dataset.act === 'step') {
      if (!v.live) return;
      this._setUnits(Math.round(toUnits(v.target, v.step)) + Number(el.dataset.d), v);
    } else if (el.dataset.act === 'mode' || el.dataset.act === 'fan') {
      if (!v.available) return;
      this._step(el.dataset.act, { type: 'input', value: el.dataset.v });
    }
    this._render();
  }

  _onKey(e) {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!d || !this._hass || !this._f) return;
    const v = this._view();
    if (!v.live) return;
    e.preventDefault();
    this._setUnits(Math.round(toUnits(v.target, v.step)) + d, v);
    this._render();
  }

  /** A pointer position in dial units. */
  _xy(e) {
    const b = this._el.svg.getBoundingClientRect();
    return { x: ((e.clientX - b.left) / b.width) * BOX - PAD, y: ((e.clientY - b.top) / b.height) * BOX - PAD };
  }

  /** On the handle: start a drag. On the track: jump there first. Anywhere else: nothing. */
  _onPointerDown(e) {
    if (this._drag || !this._hass || !this._f) return;
    const v = this._view();
    if (!v.live) return;
    const p = this._xy(e);
    const units = toUnits(v.target, v.step);
    const h = dialPoint(dialAngle(Math.min(v.range.max, Math.max(v.range.min, units)), v.range));
    const at = Math.hypot(p.x - h.x, p.y - h.y) <= 40 ? units : dialTap(p.x, p.y, v.range);
    if (at === null) return;
    e.preventDefault();
    try {
      this._el.svg.setPointerCapture?.(e.pointerId);
    } catch {
      /* no such active pointer (a synthetic event): the drag still works while the pointer stays over the dial */
    }
    this._drag = { id: e.pointerId, range: v.range };
    this._step('temp', { type: 'down' });
    if (at !== units) this._setUnits(at, v);
    this._render();
  }

  _onDrag(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    if (e.type === 'pointermove') {
      const v = this._view();
      const p = this._xy(e);
      const prev = toUnits(v.target, v.step);
      const next = dialDrag(p.x, p.y, d.range, prev);
      if (next !== prev && this._setUnits(next, v)) this._render();
      return;
    }
    this._drag = null;
    this._step('temp', { type: 'up' });
    this._render();
  }

  // ---- render -----------------------------------------------------------------------------------

  _render() {
    const e = this._el;
    if (!e || !this._hass || !this._f) return;
    const v = this._view();
    const f = this._f;
    setText(e.name, this._name());
    e.dial.style.setProperty('--mc', v.color);
    e.dial.dataset.live = String(v.live);
    setText(e.num, v.centre.text);
    e.num.classList.toggle('room', v.centre.room);
    setText(e.status, v.status);
    for (const b of e.steps) b.disabled = !v.live;

    const { min, max } = v.range;
    const key = `${min}-${max}-${v.step}`;
    if (e.track.dataset.range !== key) {
      e.track.dataset.range = key;
      e.ticks.setAttribute('d', max - min <= MAX_TICKS ? tickPath(v.range) : '');
      for (const [el, u] of [[e.min, min], [e.max, max]]) {
        const p = dialPoint(dialAngle(u, v.range));
        el.setAttribute('x', p.x.toFixed(1));
        el.setAttribute('y', (p.y + 40).toFixed(1));
        el.textContent = String(fromUnits(u, v.step, v.digits));
      }
    }
    const clampU = (t) => Math.min(max, Math.max(min, toUnits(t, v.step)));
    // The handle: the target, or nothing when there is none (Off without a kept target, or a low/high pair).
    e.handle.style.display = v.target === null ? 'none' : '';
    if (v.target !== null) {
      const p = dialPoint(dialAngle(clampU(v.target), v.range));
      e.handle.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    }
    e.ring.classList.toggle('sending', !!f.temp.pending);
    // The fill runs from the room temperature to the target; a low/high pair draws its own span instead.
    let fill = '';
    if (v.live) fill = fillPath(v.current === null ? null : toUnits(v.current, v.step), toUnits(v.target, v.step), v.range);
    else if (v.dual) fill = arcPath(dialAngle(clampU(v.low), v.range), dialAngle(clampU(v.high), v.range));
    e.fill.setAttribute('d', fill);
    e.glow.setAttribute('d', fill);
    e.now.style.display = v.current === null ? 'none' : '';
    if (v.current !== null) {
      const p = dialPoint(dialAngle(clampU(v.current), v.range));
      e.now.setAttribute('cx', p.x.toFixed(1));
      e.now.setAttribute('cy', p.y.toFixed(1));
    }
    e.svg.setAttribute('aria-valuemin', String(fromUnits(min, v.step, v.digits)));
    e.svg.setAttribute('aria-valuemax', String(fromUnits(max, v.step, v.digits)));
    if (v.target === null) e.svg.removeAttribute('aria-valuenow');
    else e.svg.setAttribute('aria-valuenow', String(v.target));
    e.svg.setAttribute('aria-valuetext', v.status);
    e.svg.setAttribute('aria-disabled', String(!v.live));

    const chip = (act, [val, label], field, color) => `<button type="button" class="chip" data-act="${act}" data-v="${esc(val)}" aria-pressed="${val === field.shown}"${field.pending?.value === val ? ' data-pending' : ''} style="--c:${color}">${act === 'mode' ? '<i></i>' : ''}${esc(label)}</button>`;
    e.modeBox.hidden = !v.modes.length;
    e.fanBox.hidden = !v.fans.length;
    setHTML(e.modes, v.modes.map((m) => chip('mode', m, f.mode, thermostatView({ state: m[0], attributes: {} }).color)).join(''));
    setHTML(e.fans, v.fans.map((m) => chip('fan', m, f.fan, 'var(--primary-color, #03a9f4)')).join(''));
  }
}

// A second copy (e.g. the resource listed under two ?v= values) must not throw.
if (globalThis.customElements && !customElements.get('wall-thermostat-card')) {
  customElements.define('wall-thermostat-card', WallThermostatCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'wall-thermostat-card',
    name: 'Wall Thermostat Card',
    description: 'A thermostat dial for one climate entity: target, current temperature, mode and fan.',
  });
}

export { WallThermostatCard };
