/**
 * Multitech Production v4.0
 * Features: Escalating Alarm, Web Worker, Math Challenge, Dissonant Audio
 */

// --- UTILITIES & STORAGE ---
const Utils = {
    uuid: () => Date.now().toString(36) + Math.random().toString(36).substr(2),
    $(sel) { return document.querySelector(sel); },
    $all(sel) { return document.querySelectorAll(sel); },
    storage: {
        get: (key, def) => {
            try { return JSON.parse(localStorage.getItem(`mt_v4_${key}`)) || def; } 
            catch { return def; }
        },
        set: (key, val) => {
            try { localStorage.setItem(`mt_v4_${key}`, JSON.stringify(val)); }
            catch(e) { Toast.show("Storage Full!", "error"); }
        },
        remove: (key) => localStorage.removeItem(`mt_v4_${key}`),
        clear: () => {
            Object.keys(localStorage).forEach(k => {
                if(k.startsWith('mt_v4_')) localStorage.removeItem(k);
            });
        },
        size: () => Math.round(JSON.stringify(localStorage).length / 1024) + ' KB'
    },
    pad: (n) => n<10 ? '0'+n : n
};

// --- WEB WORKER BLOB (For Reliable Timing) ---
// This runs in a background thread to prevent browser throttling
const workerCode = `
    setInterval(() => {
        postMessage('tick');
    }, 1000);
`;
const workerBlob = new Blob([workerCode], {type: 'application/javascript'});
const workerUrl = URL.createObjectURL(workerBlob);

// --- ADVANCED SOUND MANAGER ---
class SoundManager {
    constructor() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.masterGain = null;
        this.oscillators = [];
        this.isRing = false;
        this.escalationInterval = null;
    }

    ensureContext() {
        if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    // Standard beep for timer/UI interaction
    playBeep() {
        this.ensureContext();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.frequency.setValueAtTime(880, this.ctx.currentTime);
        gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.3);
        osc.start();
        osc.stop(this.ctx.currentTime + 0.3);
    }

    // Start Escalating Alarm Sequence
    startAlarmSequence() {
        if (this.isRing) return;
        this.ensureContext();
        this.isRing = true;

        // Master Gain for Volume Escalation
        this.masterGain = this.ctx.createGain();
        this.masterGain.connect(this.ctx.destination);
        this.masterGain.gain.setValueAtTime(0.01, this.ctx.currentTime);
        
        // Ramp volume up over 30 seconds
        this.masterGain.gain.linearRampToValueAtTime(1.0, this.ctx.currentTime + 30);

        // Create two oscillators for dissonance (Annoying beat frequency)
        const freqs = [500, 504]; // 4Hz difference creates a wobble
        
        freqs.forEach(f => {
            const osc = this.ctx.createOscillator();
            osc.type = 'sawtooth'; // Harsher sound
            osc.frequency.value = f;
            osc.connect(this.masterGain);
            osc.start();
            this.oscillators.push(osc);
        });

        // Pulsing effect handled by another gain node LFO if needed, 
        // but for now, continuous dissonant drone is very effective.
    }

    stopAlarmSequence() {
        if (!this.isRing) return;
        this.oscillators.forEach(o => o.stop());
        this.oscillators = [];
        if(this.masterGain) this.masterGain.disconnect();
        this.isRing = false;
    }
}

class Toast {
    static show(msg, type = 'info') {
        const c = Utils.$('#toast-container');
        const el = document.createElement('div');
        el.className = 'toast';
        if(type === 'error') el.style.borderLeft = '4px solid var(--danger)';
        else el.style.borderLeft = '4px solid var(--primary)';
        
        el.innerHTML = `<span>${msg}</span><button onclick="this.parentElement.remove()" style="background:none;border:none;color:white;cursor:pointer">&times;</button>`;
        c.appendChild(el);
        setTimeout(() => el.remove(), 4000);
    }
}

// --- MODAL MANAGER ---
class ModalManager {
    constructor() {
        this.overlay = Utils.$('#modal-backdrop');
        this.title = Utils.$('#modal-title');
        this.body = Utils.$('#modal-body');
        this.footer = Utils.$('#modal-footer');
        
        const closer = () => this.close();
        Utils.$('#modal-close').onclick = closer;
        this.overlay.onclick = (e) => { if(e.target === this.overlay) closer(); };
        
        document.addEventListener('keydown', (e) => {
            if(e.key === 'Escape' && this.overlay.classList.contains('open')) closer();
        });
    }

    open(title, contentHTML, buttons = []) {
        this.title.innerText = title;
        this.body.innerHTML = contentHTML;
        this.footer.innerHTML = '';
        
        buttons.forEach(btn => {
            const b = document.createElement('button');
            b.className = `primary-btn ${btn.class || ''}`;
            b.innerText = btn.text;
            b.onclick = () => {
                if(btn.onClick) btn.onClick();
                if(btn.close !== false) this.close();
            };
            this.footer.appendChild(b);
        });

        this.overlay.classList.add('open');
        this.overlay.setAttribute('aria-hidden', 'false');
    }

    close() { 
        this.overlay.classList.remove('open'); 
        this.overlay.setAttribute('aria-hidden', 'true');
    }
}

// --- MODULES ---

class AlarmSystem {
    constructor(modal, soundMgr) {
        this.modal = modal;
        this.sound = soundMgr;
        this.alarms = Utils.storage.get('alarms', []);
        this.snoozed = [];
        
        // Worker Setup
        this.worker = new Worker(workerUrl);
        this.worker.onmessage = () => this.check();

        // UI Overlay Elements
        this.overlay = Utils.$('#alarm-overlay');
        this.ovTime = Utils.$('#overlay-time');
        this.ovLabel = Utils.$('#overlay-label');
        this.ovProb = Utils.$('#math-prob');
        this.ovAns = Utils.$('#math-answer');
        this.ovChalDiv = Utils.$('#overlay-challenge');
        this.activeAlarm = null;
        this.mathSol = 0;

        // Bindings
        Utils.$('#overlay-snooze').onclick = () => this.snooze();
        Utils.$('#overlay-dismiss').onclick = () => this.attemptDismiss();
        Utils.$('#new-alarm-trigger').onclick = () => this.openEditor();
        
        this.render();
    }

    openEditor(id = null) {
        // Default to a medium difficulty alarm if new
        const alarm = id ? this.alarms.find(a => a.id === id) : { time: '08:00', label: 'Wake Up', days: [], strict: false, difficulty: 'medium' };
        
        const daysHtml = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => `
            <label class="day-check"><input type="checkbox" value="${i}" ${alarm.days.includes(i)?'checked':''}> ${d}</label>
        `).join('');

        const html = `
            <div class="form-group"><label>Time</label><input type="time" id="a-time" value="${alarm.time}"></div>
            <div class="form-group"><label>Label</label><input type="text" id="a-label" value="${alarm.label}"></div>
            
            <div class="form-group">
                <label>Difficulty Level</label>
                <select id="a-difficulty">
                    <option value="easy" ${alarm.difficulty === 'easy' ? 'selected' : ''}>Easy (Simple Math)</option>
                    <option value="medium" ${alarm.difficulty === 'medium' ? 'selected' : ''}>Medium (Mixed Ops)</option>
                    <option value="hard" ${alarm.difficulty === 'hard' ? 'selected' : ''}>Hard (Large Numbers / Logic)</option>
                </select>
            </div>

            <div class="form-group">
                <label class="day-check"><input type="checkbox" id="a-strict" ${alarm.strict?'checked':''}> <strong>Strict Mode</strong> (Math Challenge)</label>
            </div>
            <div class="form-group"><label>Repeat</label><div class="checkbox-group">${daysHtml}</div></div>
        `;

        this.modal.open(id ? 'Edit Alarm' : 'New Alarm', html, [
            { text: 'Save', onClick: () => this.save(id) }
        ]);
    }

    save(id) {
        const time = Utils.$('#a-time').value;
        const label = Utils.$('#a-label').value;
        const strict = Utils.$('#a-strict').checked;
        const difficulty = Utils.$('#a-difficulty').value;
        const days = Array.from(Utils.$all('.checkbox-group input:checked')).map(cb => parseInt(cb.value));
        
        if(!time) return Toast.show('Time required', 'error');

        const newAlarm = { time, label, days, strict, difficulty }; 
        
        if(id) {
            const idx = this.alarms.findIndex(a => a.id === id);
            this.alarms[idx] = { ...this.alarms[idx], ...newAlarm };
        } else {
            this.alarms.push({ id: Utils.uuid(), enabled: true, ...newAlarm });
        }
        
        Utils.storage.set('alarms', this.alarms);
        this.render();
    }

    render() {
        const c = Utils.$('#alarm-list');
        c.innerHTML = '';
        if(this.alarms.length === 0) c.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">No Alarms Set</div>';
        
        this.alarms.forEach(a => {
            const dayStr = a.days.length === 7 ? 'Everyday' : a.days.length === 0 ? 'Once' : 'Selected Days';
            const difficultyTag = a.difficulty ? `(${a.difficulty.charAt(0).toUpperCase()})` : '';
            c.innerHTML += `
                <div class="alarm-item">
                    <div class="alarm-info">
                        <h4>${a.time}</h4>
                        <div>
                            ${a.label} 
                            ${a.strict ? '<span style="color:var(--danger);font-size:0.8em;font-weight:bold">[STRICT]</span>' : ''} 
                            ${a.strict ? `<span style="color:var(--primary);font-size:0.8em;font-weight:bold">${difficultyTag}</span>` : ''} 
                            <small class="alarm-days">• ${dayStr}</small>
                        </div>
                    </div>
                    <div class="alarm-controls">
                        <input type="checkbox" ${a.enabled?'checked':''} onchange="app.modules.alarm.toggle('${a.id}')" style="width:20px;height:20px">
                        <button class="icon-btn" onclick="app.modules.alarm.openEditor('${a.id}')"><i class="material-icons-round">edit</i></button>
                        <button class="icon-btn" onclick="app.modules.alarm.del('${a.id}')"><i class="material-icons-round">delete</i></button>
                    </div>
                </div>`;
        });
    }

    toggle(id) {
        const a = this.alarms.find(x => x.id === id);
        if(a) a.enabled = !a.enabled;
        Utils.storage.set('alarms', this.alarms);
    }
    del(id) {
        if(confirm('Delete alarm?')) {
            this.alarms = this.alarms.filter(a => a.id !== id);
            this.sound.stopAlarmSequence(); // Stop if the deleted alarm was active
            this.render();
            Utils.storage.set('alarms', this.alarms);
        }
    }

    // --- TRIGGER LOGIC ---
    check() {
        const now = new Date();
        const tStr = now.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'}); // HH:mm
        const day = now.getDay();
        
        if(now.getSeconds() === 0) {
            // Check Main Alarms
            this.alarms.forEach(a => {
                if(a.enabled && a.time === tStr && (a.days.length === 0 || a.days.includes(day))) {
                    this.trigger(a);
                    if(a.days.length === 0) { a.enabled = false; this.render(); }
                }
            });
            // Check Snoozed
            this.snoozed.forEach((s, i) => {
                // Allow 1 second tolerance
                if(Math.abs(s.time - now.getTime()) < 2000) {
                    this.trigger(s.alarm);
                    this.snoozed.splice(i, 1);
                }
            });
        }
    }

    trigger(alarm) {
        if(this.activeAlarm) return; // Already ringing
        this.activeAlarm = alarm;

        // Visuals
        this.overlay.classList.remove('hidden');
        this.overlay.classList.add('active'); // Start flashing
        this.ovTime.innerText = alarm.time;
        this.ovLabel.innerText = alarm.label;

        // Challenge Setup
        if(alarm.strict) {
            this.ovChalDiv.classList.remove('hidden');
            Utils.$('#overlay-snooze').style.display = 'block'; // Snooze allowed
            this.generateMath();
        } else {
            this.ovChalDiv.classList.add('hidden');
            Utils.$('#overlay-snooze').style.display = 'block';
        }

        // Sound
        this.sound.startAlarmSequence();
        
        // Notifications
        if(Notification.permission === 'granted') new Notification('ALARM: ' + alarm.label);
    }

    generateMath() {
        const difficulty = this.activeAlarm.difficulty || 'medium';
        const problemType = this.activeAlarm.difficulty === 'hard' ? 
                            Math.floor(Math.random() * 3) : // Hard can be Logic, Mixed, or Simple
                            Math.floor(Math.random() * 2);  // Easy/Medium is Mixed or Simple

        let a, b, c, operator, mathProbText, result;

        // 1. Determine number range based on difficulty
        switch (difficulty) {
            case 'easy':
                a = Math.floor(Math.random() * 10) + 1;
                b = Math.floor(Math.random() * 10) + 1;
                c = Math.floor(Math.random() * 5) + 1;
                break;
            case 'hard':
                a = Math.floor(Math.random() * 50) + 10;
                b = Math.floor(Math.random() * 10) + 2;
                c = Math.floor(Math.random() * 30) + 10;
                break;
            case 'medium':
            default:
                a = Math.floor(Math.random() * 20) + 3;
                b = Math.floor(Math.random() * 8) + 3;
                c = Math.floor(Math.random() * 20) + 10;
        }

        // 2. Generate problem based on type (Logic available only on 'hard')
        if (problemType === 0) { // Type 0: Simple Arithmetic (e.g., A + B)
            operator = ['+', '-', 'x'][Math.floor(Math.random() * 3)];
            
            if (operator === '+') {
                result = a + b;
                mathProbText = `${a} + ${b}`;
            } else if (operator === '-') {
                if (a < b) [a, b] = [b, a]; // Ensure positive result
                result = a - b;
                mathProbText = `${a} - ${b}`;
            } else { // 'x'
                result = a * b;
                mathProbText = `${a} x ${b}`;
            }

        } else if (problemType === 1) { // Type 1: Mixed Arithmetic (e.g., (A * B) + C)
            result = (a * b) + c;
            mathProbText = `(${a} x ${b}) + ${c}`;

        } else { // Type 2: Bitwise Logic (For 'hard' only - Relevant to CSE/Robotics)
            // Use smaller numbers for bitwise operations 
            a = Math.floor(Math.random() * 16) + 4; // 4-19
            b = Math.floor(Math.random() * 8) + 1;  // 1-8
            const bitwiseOp = ['&', '|', '>>', '<<'][Math.floor(Math.random() * 4)];
            
            if (bitwiseOp === '&') {
                result = a & b;
            } else if (bitwiseOp === '|') {
                result = a | b;
            } else if (bitwiseOp === '>>') {
                b = Math.floor(Math.random() * 3) + 1;
                result = a >> b;
            } else { // '<<'
                b = Math.floor(Math.random() * 3) + 1;
                result = a << b;
            }
            mathProbText = `${a} ${bitwiseOp} ${b} (Base 10)`;
        }

        this.mathSol = result;
        this.ovProb.innerText = mathProbText;
        this.ovAns.value = '';
        this.ovAns.focus();
    }

    attemptDismiss() {
        if(!this.activeAlarm) return;

        if(this.activeAlarm.strict) {
            const val = parseInt(this.ovAns.value);
            if(val === this.mathSol) {
                this.stop();
            } else {
                this.ovAns.value = '';
                this.ovAns.classList.add('shake');
                setTimeout(() => this.ovAns.classList.remove('shake'), 500);
                Toast.show("Wrong Answer!", "error");
            }
        } else {
            this.stop();
        }
    }

    snooze() {
        if(!this.activeAlarm) return;
        
        // For now, allow snooze (5m)
        this.snoozed.push({ time: Date.now() + 5*60000, alarm: this.activeAlarm });
        this.stop();
        Toast.show("Snoozed for 5 minutes");
    }

    stop() {
        this.sound.stopAlarmSequence();
        this.overlay.classList.remove('active');
        this.overlay.classList.add('hidden');
        this.activeAlarm = null;
    }
}

class TodoList {
    constructor() {
        this.todos = Utils.storage.get('todos', []);
        this.render();
        
        Utils.$('#add-todo-btn').onclick = () => this.add();
        Utils.$('#new-todo-input').addEventListener('keypress', (e) => {
            if(e.key === 'Enter') this.add();
        });
        Utils.$('#clear-todos-btn').onclick = () => this.clearCompleted();
    }
    
    add() {
        const input = Utils.$('#new-todo-input');
        const text = input.value.trim();
        if(!text) return;
        
        this.todos.push({ id: Utils.uuid(), text, done: false });
        Utils.storage.set('todos', this.todos);
        input.value = '';
        this.render();
    }
    
    toggle(id) {
        const t = this.todos.find(x => x.id === id);
        if(t) t.done = !t.done;
        Utils.storage.set('todos', this.todos);
        this.render();
    }
    
    delete(id) {
        this.todos = this.todos.filter(x => x.id !== id);
        Utils.storage.set('todos', this.todos);
        this.render();
    }
    
    clearCompleted() {
        if(confirm('Remove all completed tasks?')) {
            this.todos = this.todos.filter(x => !x.done);
            Utils.storage.set('todos', this.todos);
            this.render();
        }
    }
    
    render() {
        const list = Utils.$('#todo-list');
        list.innerHTML = '';
        if(this.todos.length === 0) {
            list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">No tasks yet</div>';
            return;
        }
        
        this.todos.forEach(t => {
            const div = document.createElement('div');
            div.className = `todo-item ${t.done ? 'completed' : ''}`;
            div.innerHTML = `
                <input type="checkbox" ${t.done ? 'checked' : ''} onchange="app.modules.todos.toggle('${t.id}')">
                <span style="flex:1">${t.text}</span>
                <button class="icon-btn" onclick="app.modules.todos.delete('${t.id}')"><i class="material-icons-round">delete</i></button>
            `;
            list.appendChild(div);
        });
    }
}

class TimerSystem {
    constructor(soundMgr) {
        this.sound = soundMgr;
        this.interval = null;
        this.endTime = null;
        this.remaining = 0;
        this.isRunning = false;

        Utils.$all('.tab-btn').forEach(b => b.onclick = () => this.switchTab(b));
        Utils.$('#timer-start').onclick = () => this.toggleTimer();
        Utils.$('#timer-reset').onclick = () => this.resetTimer();
        
        // Pomodoro
        Utils.$('#pomo-start').onclick = () => this.toggleTimer('pomo');
        Utils.$('#pomo-reset').onclick = () => this.resetPomo();
        
        // Pomo Presets using delegation
        Utils.$('#pomo-presets').onclick = (e) => {
            if(e.target.classList.contains('pomo-btn')) {
                const min = parseInt(e.target.dataset.min);
                this.setPomo(min);
            }
        };

        // Stopwatch
        this.sw = { start: 0, elapsed: 0, interval: null, lapCounter: 1 };
        Utils.$('#sw-start').onclick = () => this.toggleSw();
        Utils.$('#sw-reset').onclick = () => this.resetSw();
        Utils.$('#sw-lap').onclick = () => this.lapSw();
    }

    switchTab(btn) {
        Utils.$all('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        Utils.$all('.timer-mode').forEach(m => m.classList.add('hidden'));
        Utils.$('#' + btn.dataset.tab).classList.remove('hidden');
    }

    // Timer / Pomo Shared Logic
    toggleTimer(type = 'normal') {
        const displayId = type === 'pomo' ? '#pomo-display' : '#timer-display';
        const btnId = type === 'pomo' ? '#pomo-start' : '#timer-start';

        if(this.isRunning) {
            clearInterval(this.interval);
            this.isRunning = false;
            Utils.$(btnId + ' i').innerText = 'play_arrow';
        } else {
            if(type === 'normal' && this.remaining === 0) {
                const h = parseInt(Utils.$('#t-h').value) || 0;
                const m = parseInt(Utils.$('#t-m').value) || 0;
                const s = parseInt(Utils.$('#t-s').value) || 0;
                if(m > 59 || s > 59) return Toast.show("Invalid Time: Max 59 min/sec", "error");
                if(h < 0 || m < 0 || s < 0) return Toast.show("Positive numbers only", "error");
                this.remaining = (h*3600 + m*60 + s) * 1000;
            }
            if(this.remaining <= 0) return;

            this.endTime = Date.now() + this.remaining;
            this.isRunning = true;
            Utils.$(btnId + ' i').innerText = 'pause';
            
            this.interval = setInterval(() => {
                this.remaining = this.endTime - Date.now();
                if(this.remaining <= 0) {
                    this.resetTimer(type);
                    this.sound.playBeep();
                    Toast.show(type === 'pomo' ? 'Pomodoro Complete!' : 'Timer Finished!');
                } else {
                    const iso = new Date(this.remaining).toISOString().substr(11, 8);
                    Utils.$(displayId).innerText = type==='pomo' ? iso.substr(3,5) : iso;
                }
            }, 100);
        }
    }

    setPomo(min) {
        this.resetPomo();
        this.remaining = min * 60000;
        Utils.$('#pomo-display').innerText = `${Utils.pad(min)}:00`;
    }
    resetPomo() {
        clearInterval(this.interval);
        this.isRunning = false;
        this.remaining = 25 * 60000;
        Utils.$('#pomo-display').innerText = "25:00";
        Utils.$('#pomo-start i').innerText = 'play_arrow';
    }

    resetTimer(type='normal') {
        clearInterval(this.interval);
        this.isRunning = false;
        this.remaining = 0;
        if(type==='normal') {
            Utils.$('#timer-start i').innerText = 'play_arrow';
            Utils.$('#timer-display').innerText = "00:00:00";
        } else {
            this.resetPomo();
        }
    }

    // Stopwatch
    toggleSw() {
        if(this.sw.interval) {
            clearInterval(this.sw.interval);
            this.sw.interval = null;
            this.sw.elapsed += Date.now() - this.sw.start;
            Utils.$('#sw-start i').innerText = 'play_arrow';
        } else {
            this.sw.start = Date.now();
            Utils.$('#sw-start i').innerText = 'pause';
            this.sw.interval = setInterval(() => {
                const total = this.sw.elapsed + (Date.now() - this.sw.start);
                Utils.$('#sw-display').innerText = new Date(total).toISOString().substr(14, 5) + '.' + Math.floor((total%1000)/100);
            }, 50);
        }
    }
    lapSw() {
        if(this.sw.interval || this.sw.elapsed > 0) {
            const d = document.createElement('div');
            d.innerHTML = `<span>Lap ${this.sw.lapCounter++}</span> <span>${Utils.$('#sw-display').innerText}</span>`;
            d.style.cssText = "display:flex;justify-content:space-between;padding:5px;border-bottom:1px solid var(--border)";
            Utils.$('#sw-laps').prepend(d);
        }
    }
    resetSw() {
        clearInterval(this.sw.interval);
        this.sw.interval = null;
        this.sw.elapsed = 0;
        this.sw.lapCounter = 1;
        Utils.$('#sw-display').innerText = "00:00.00";
        Utils.$('#sw-laps').innerHTML = '';
        Utils.$('#sw-start i').innerText = 'play_arrow';
    }
}

class Calculator {
    constructor() {
        this.display = Utils.$('#calc-display');
        this.history = Utils.$('#calc-history');
        this.expr = "";
        
        Utils.$all('.calc-pad button').forEach(b => {
            b.onclick = () => this.handle(b.dataset);
        });
    }
    
    handle(data) {
        const { num, op, action } = data;
        
        if(num !== undefined) this.expr += num;
        if(op) {
            if(op === 'sqrt') this.expr += 'Math.sqrt(';
            else if(op === '^') this.expr += '**';
            else this.expr += op;
        }
        
        if(action === 'clear') { this.expr = ""; this.history.innerText = ""; }
        if(action === 'del') { this.expr = this.expr.slice(0, -1); }
        
        if(action === 'equal') {
            try {
                this.history.innerText = this.expr;
                // SAFE EVALUATION
                const safeExpr = this.expr.replace(/[^0-9+\-*/().%^sqrtMath\s]/g, '');
                if(safeExpr !== this.expr) throw new Error("Invalid Characters");
                
                // Allow Math functions, prevent arbitrary code
                const result = new Function(`return ${safeExpr}`)();
                
                const final = Number.isInteger(result) ? result : parseFloat(result.toFixed(6));
                this.display.innerText = final;
                this.expr = String(final);
            } catch {
                this.display.innerText = "Error";
                this.expr = "";
            }
        } else {
            this.display.innerText = this.expr || "0";
        }
    }
}

class CalendarSystem {
    constructor(modal) {
        this.modal = modal;
        this.events = Utils.storage.get('events', []);
        this.date = dayjs();
        this.render();
        
        Utils.$('#cal-prev').onclick = () => { this.date = this.date.subtract(1, 'month'); this.render(); };
        Utils.$('#cal-next').onclick = () => { this.date = this.date.add(1, 'month'); this.render(); };
        Utils.$('#add-event-btn').onclick = () => this.openEditor(null, this.date.format('YYYY-MM-DD'));
    }

    openEditor(id, defaultDate) {
        const ev = id ? this.events.find(e => e.id === id) : { title:'', date: defaultDate, desc:'', color:'#4f46e5' };
        
        const html = `
            <div class="form-group"><label>Title</label><input type="text" id="ev-title" value="${ev.title}"></div>
            <div class="form-group"><label>Date</label><input type="date" id="ev-date" value="${ev.date}"></div>
            <div class="form-group"><label>Description</label><textarea id="ev-desc" rows="3">${ev.desc||''}</textarea></div>
        `;

        const btns = [{ text: 'Save', onClick: () => this.save(id) }];
        if(id) btns.push({ text: 'Delete', class:'danger', onClick: () => this.del(id) });

        this.modal.open(id ? 'Edit Event' : 'New Event', html, btns);
    }

    save(id) {
        const title = Utils.$('#ev-title').value;
        const date = Utils.$('#ev-date').value;
        const desc = Utils.$('#ev-desc').value;

        if(!title || !date) return Toast.show('Title & Date required', 'error');

        if(id) {
            const idx = this.events.findIndex(e => e.id === id);
            this.events[idx] = { id, title, date, desc, color: '#4f46e5' };
        } else {
            this.events.push({ id: Utils.uuid(), title, date, desc, color: '#4f46e5' });
        }
        Utils.storage.set('events', this.events);
        this.render();
    }

    del(id) {
        this.events = this.events.filter(e => e.id !== id);
        Utils.storage.set('events', this.events);
        this.render();
    }

    render() {
        Utils.$('#cal-month-name').innerText = this.date.format('MMMM YYYY');
        const grid = Utils.$('#cal-grid');
        grid.innerHTML = '';
        
        const start = this.date.startOf('month');
        const days = this.date.daysInMonth();
        const offset = start.day();

        for(let i=0; i<offset; i++) grid.appendChild(document.createElement('div'));

        for(let i=1; i<=days; i++) {
            const dStr = this.date.date(i).format('YYYY-MM-DD');
            const dayEvents = this.events.filter(e => e.date === dStr);
            const isToday = dStr === dayjs().format('YYYY-MM-DD');
            
            const dots = dayEvents.map(e => `<span class="event-dot" style="background:${e.color||'var(--primary)'}"></span>`).join('');
            
            const cell = document.createElement('div');
            cell.className = `day-cell ${isToday ? 'today' : ''}`;
            cell.innerHTML = `<div>${i}</div><div>${dots}</div>`;
            cell.onclick = () => {
                if(dayEvents.length) this.showDayDetails(dStr, dayEvents);
                else this.openEditor(null, dStr);
            };
            grid.appendChild(cell);
        }
    }

    showDayDetails(date, events) {
        const html = events.map(e => `
            <div style="padding:10px; border-left:4px solid ${e.color}; background:var(--bg-input); margin-bottom:5px; cursor:pointer" 
                 onclick="app.modules.calendar.openEditor('${e.id}')">
                <strong>${e.title}</strong><br><small>${e.desc || 'No desc'}</small>
            </div>
        `).join('') + `<button class="primary-btn sm" style="margin-top:10px" onclick="app.modules.calendar.openEditor(null, '${date}')">+ Add</button>`;
        
        this.modal.open(`Events: ${date}`, html, []);
    }
}

class Notepad {
    constructor() {
        this.notes = Utils.storage.get('notes', []);
        this.activeId = null;
        this.editor = Utils.$('#note-editor');
        this.titleInput = Utils.$('#note-title-input');
        this.tagsInput = Utils.$('#note-tags-input');
        
        this.bindEvents();
        this.renderList();
    }

    bindEvents() {
        Utils.$('#note-create').onclick = () => this.create();
        Utils.$('#note-delete').onclick = () => this.del();
        Utils.$('#note-search').oninput = (e) => this.renderList(e.target.value);
        Utils.$('#note-sort').onchange = () => this.renderList();
        
        let timeout;
        const saveHandler = () => {
            Utils.$('#note-save-status').innerText = 'Saving...';
            clearTimeout(timeout);
            timeout = setTimeout(() => this.save(), 800);
        };
        
        this.editor.oninput = saveHandler;
        this.titleInput.oninput = saveHandler;
        this.tagsInput.oninput = saveHandler;

        Utils.$all('.editor-toolbar button[data-cmd]').forEach(b => {
            b.onclick = (e) => { e.preventDefault(); document.execCommand(b.dataset.cmd, false, null); };
        });
    }

    create() {
        const note = { id: Utils.uuid(), title: 'New Note', content: '', tags: '', updated: Date.now() };
        this.notes.unshift(note);
        this.saveState();
        this.load(note.id);
        this.renderList();
    }

    load(id) {
        this.activeId = id;
        const n = this.notes.find(x => x.id === id);
        this.editor.innerHTML = DOMPurify.sanitize(n.content);
        this.titleInput.value = n.title;
        this.tagsInput.value = n.tags || '';
        
        Utils.$all('.note-item').forEach(el => el.classList.remove('active'));
        const item = document.getElementById('n-'+id);
        if(item) item.classList.add('active');
    }

    save() {
        if(!this.activeId) return;
        const n = this.notes.find(x => x.id === this.activeId);
        n.content = this.editor.innerHTML;
        n.title = this.titleInput.value || 'Untitled';
        n.tags = this.tagsInput.value;
        n.updated = Date.now();
        
        this.saveState();
        Utils.$('#note-save-status').innerText = 'Saved';
        this.renderList(Utils.$('#note-search').value);
    }

    del() {
        if(confirm('Delete note?')) {
            this.notes = this.notes.filter(n => n.id !== this.activeId);
            this.saveState();
            this.editor.innerHTML = '';
            this.titleInput.value = '';
            this.activeId = null;
            this.renderList();
        }
    }

    saveState() { Utils.storage.set('notes', this.notes); }

    renderList(query = '') {
        const sort = Utils.$('#note-sort').value;
        let list = this.notes.filter(n => 
            n.title.toLowerCase().includes(query.toLowerCase()) || 
            (n.tags && n.tags.toLowerCase().includes(query.toLowerCase()))
        );

        list.sort((a,b) => sort === 'date' ? b.updated - a.updated : a.title.localeCompare(b.title));

        const container = Utils.$('#note-list');
        container.innerHTML = '';
        list.forEach(n => {
            const div = document.createElement('div');
            div.className = `note-item ${n.id === this.activeId ? 'active' : ''}`;
            div.id = 'n-'+n.id;
            div.innerHTML = `<strong>${n.title}</strong><br><small style="color:var(--text-muted)">${new Date(n.updated).toLocaleDateString()}</small>`;
            div.onclick = () => this.load(n.id);
            container.appendChild(div);
        });
    }
}

class SettingsManager {
    constructor(modal) {
        this.modal = modal;
        this.settings = Utils.storage.get('settings', { clock24: false, dateFormat: 'US' });
        
        Utils.$('#settings-btn').onclick = () => this.open();
        
        const applyTheme = (isDark) => {
            document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
            Utils.$('#theme-btn i').innerText = isDark ? 'light_mode' : 'dark_mode';
        };
        const savedTheme = Utils.storage.get('theme', false);
        applyTheme(savedTheme);
        
        Utils.$('#theme-btn').onclick = () => {
            const isDark = document.documentElement.getAttribute('data-theme') !== 'dark';
            applyTheme(isDark);
            Utils.storage.set('theme', isDark);
        };
    }
    
    open() {
        const html = `
            <div class="form-group">
                <label class="day-check">
                    <input type="checkbox" id="set-clock" ${this.settings.clock24?'checked':''}> 24-Hour Clock
                </label>
            </div>
            <div class="form-group">
                <label>Date Format</label>
                <select id="set-date">
                    <option value="US" ${this.settings.dateFormat==='US'?'selected':''}>MM/DD/YYYY</option>
                    <option value="UK" ${this.settings.dateFormat==='UK'?'selected':''}>DD/MM/YYYY</option>
                </select>
            </div>
            <hr style="margin:20px 0; border:0; border-top:1px solid var(--border)">
            <button class="primary-btn full" onclick="app.modules.data.show()" style="background:var(--text-muted)">Manage Data</button>
            <button class="primary-btn full" onclick="app.modules.data.clearAll()" style="background:var(--danger);margin-top:10px">Reset App</button>
        `;
        
        this.modal.open('Settings', html, [
            { text: 'Save', onClick: () => {
                this.settings.clock24 = Utils.$('#set-clock').checked;
                this.settings.dateFormat = Utils.$('#set-date').value;
                Utils.storage.set('settings', this.settings);
                Toast.show('Settings Saved');
            }}
        ]);
    }
}

class DataManager {
    constructor(modal) {
        this.modal = modal;
        Utils.$('#data-manager-btn').onclick = () => this.show();
    }
    
    show() {
        this.modal.open('Data Manager', `
            <p>Storage Used: <strong>${Utils.storage.size()}</strong></p>
            <button class="primary-btn full" onclick="app.modules.data.exportData()">Export Backup (.json)</button>
            <div style="margin-top:15px; border-top:1px solid var(--border); padding-top:15px;">
                <label>Restore Backup</label>
                <input type="file" id="import-file" accept=".json">
                <button class="primary-btn full" style="margin-top:10px" onclick="app.modules.data.importData()">Import</button>
            </div>
        `);
    }
    
    exportData() {
        const data = {};
        Object.keys(localStorage).forEach(k => {
            if(k.startsWith('mt_v4_')) data[k] = localStorage.getItem(k);
        });
        const blob = new Blob([JSON.stringify(data)], {type:'application/json'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `multitech_backup_${Date.now()}.json`;
        a.click();
    }
    
    importData() {
        const file = Utils.$('#import-file').files[0];
        if(!file) return Toast.show('Select file', 'error');
        
        if(!confirm("This will overwrite current data. Continue?")) return;
        
        const r = new FileReader();
        r.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                Object.keys(data).forEach(k => localStorage.setItem(k, data[k]));
                location.reload();
            } catch { Toast.show('Invalid File', 'error'); }
        };
        r.readAsText(file);
    }
    
    clearAll() {
        if(confirm("DANGER: This will delete ALL data. Are you sure?")) {
            Utils.storage.clear();
            location.reload();
        }
    }
}

// --- APP CORE ---
class App {
    constructor() {
        this.modal = new ModalManager();
        this.sound = new SoundManager();
        this.settings = new SettingsManager(this.modal);
        
        this.modules = {
            alarm: new AlarmSystem(this.modal, this.sound),
            timer: new TimerSystem(this.sound),
            calculator: new Calculator(),
            todos: new TodoList(),
            data: new DataManager(this.modal),
            calendar: new CalendarSystem(this.modal),
            notepad: new Notepad()
        };
        
        this.initRouting();
        this.initClock();
        this.initTools();
        this.initKeys();
        
        if(Notification.permission !== 'granted') Notification.requestPermission();
    }
    
    initRouting() {
        Utils.$all('.nav-btn').forEach(btn => {
            btn.onclick = () => {
                Utils.$all('.nav-btn').forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                
                Utils.$all('.module-view').forEach(m => m.classList.remove('active'));
                Utils.$('#'+btn.dataset.target).classList.add('active');
            };
        });
    }
    
    initClock() {
        const update = () => {
            const set = Utils.storage.get('settings', {clock24:false, dateFormat:'US'});
            const now = new Date();
            Utils.$('#digital-clock').innerText = now.toLocaleTimeString([], {hour12: !set.clock24});
            Utils.$('#date-display').innerText = now.toLocaleDateString(set.dateFormat==='US'?'en-US':'en-GB', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
        };
        setInterval(update, 1000); update();
        
        // Clock Cities
        const renderCities = () => {
            const cities = Utils.storage.get('cities', []);
            const container = Utils.$('#world-clock-grid');
            if(container) {
                container.innerHTML = cities.map((c,i) => `
                    <div class="tool-card" style="display:flex;justify-content:space-between;align-items:center;min-height:80px">
                        <div>
                            <div style="font-weight:600">${c}</div>
                            <div style="font-size:1.5rem">${new Date().toLocaleTimeString('en-US',{timeZone:c, hour:'2-digit',minute:'2-digit'})}</div>
                        </div>
                        <button class="icon-btn danger" onclick="app.modules.clock.removeCity(${i})">&times;</button>
                    </div>
                `).join('');
            }
        };
        
        this.modules.clock = {
            removeCity: (idx) => {
                const c = Utils.storage.get('cities', []);
                c.splice(idx, 1);
                Utils.storage.set('cities', c);
                renderCities();
            }
        };
        
        Utils.$('#add-city-btn').onclick = () => {
            const tz = prompt("Enter Timezone (e.g. Europe/London):");
            if(tz) {
                try {
                    new Date().toLocaleTimeString('en-US',{timeZone:tz});
                    const c = Utils.storage.get('cities', []);
                    c.push(tz);
                    Utils.storage.set('cities', c);
                    renderCities();
                } catch { Toast.show("Invalid Timezone", "error"); }
            }
        };
        renderCities(); setInterval(renderCities, 10000);
    }
    
    initTools() {
        // Password Generator
        Utils.$('#pwd-gen-btn').onclick = () => {
            const len = parseInt(Utils.$('#pwd-len').value) || 12;
            const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
            let pwd = "";
            for(let i=0; i<len; i++) pwd += chars.charAt(Math.floor(Math.random() * chars.length));
            Utils.$('#pwd-output').value = pwd;
        };

        // Unit Converter
        const convert = () => {
            const val = parseFloat(Utils.$('#conv-input').value);
            const from = Utils.$('#conv-from').value;
            const to = Utils.$('#conv-to').value;
            if(isNaN(val)) return;
            
            // Map types: 1=dist, 2=mass, 3=temp
            const types = { m:1, ft:1, kg:2, lb:2, c:3, f:3 };
            if(types[from] !== types[to]) {
                Utils.$('#conv-result').innerText = "Incompatible Units";
                return;
            }

            let res = 0;
            // Dist
            if(from==='m' && to==='ft') res = val * 3.28084;
            else if(from==='ft' && to==='m') res = val / 3.28084;
            // Mass
            else if(from==='kg' && to==='lb') res = val * 2.20462;
            else if(from==='lb' && to==='kg') res = val / 2.20462;
            // Temp
            else if(from==='c' && to==='f') res = (val * 9/5) + 32;
            else if(from==='f' && to==='c') res = (val - 32) * 5/9;
            else res = val; // Same unit

            Utils.$('#conv-result').innerText = `Result: ${res.toFixed(2)}`;
        };
        Utils.$('#conv-input').oninput = convert;
        Utils.$('#conv-from').onchange = convert;
        Utils.$('#conv-to').onchange = convert;
    }

    initKeys() {
        document.addEventListener('keydown', (e) => {
            if(e.ctrlKey && e.key >= '1' && e.key <= '8') {
                e.preventDefault();
                const map = ['calculator','calendar','clock','alarm','timer','notepad','todos','tools'];
                const target = map[parseInt(e.key)-1];
                const btn = Utils.$(`.nav-btn[data-target="${target}"]`);
                if(btn) btn.click();
            }
        });
    }
}

document.addEventListener('DOMContentLoaded', () => { window.app = new App(); });