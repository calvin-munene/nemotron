const COMMANDS = Object.freeze({
  Dashboard: "dashboard", Modes: "modes", Persona: "persona",
  Models: "models", "Switch Model": "model", "Reset Chat": "reset",
  Help: "help", "Admin Panel": "dashboard"
});
const INPUTS = Object.freeze({ Modes: "use", Persona: "persona", "Switch Model": "model" });
const LABELS = Object.freeze({
  Dashboard:"🏠 Dashboard", Modes:"🎛 Modes", Persona:"👤 Persona", Models:"🧠 Models",
  "Switch Model":"🔄 Switch Model", "Reset Chat":"🗑 Reset Chat", Help:"ℹ️ Help", "Admin Panel":"⚙️ Admin Panel"
});
export function keyboardLabel(text) { return Object.keys(LABELS).find(k=>LABELS[k]===text) || text; }

export function telegramCommandKeyboard(owner = false, groupsAdmin = false) {
  const button=text=>({text:LABELS[text] || text});
  return {
    keyboard: [
      [button("Dashboard"),button("Modes")],
      [button("Persona"),button("Models")],
      [button("Switch Model"),button("Reset Chat")],
      [...(groupsAdmin?[{text:"👥 My Groups"}]:[]),button("Help")],
      ...(owner ? [[button("Admin Panel")]] : [])
    ],
    resize_keyboard: true, is_persistent: true, one_time_keyboard: false
  };
}

export function keyboardCommand(text) {
  const name = COMMANDS[keyboardLabel(text)];
  return name ? { name, argument: "", addressedToThisBot: true } : null;
}

export function createCommandInputs({ now = Date.now, ttlMs = 120_000, capacity = 1000 } = {}) {
  const pending = new Map();
  return {
    clear(key) { pending.delete(key); },
    remember(key, label) {
      const command = INPUTS[keyboardLabel(label)];
      if (!command) return;
      for (const [id, item] of pending) if (item.expiresAt <= now()) pending.delete(id);
      if (pending.size >= capacity) pending.delete(pending.keys().next().value);
      pending.set(key, { command, expiresAt: now() + ttlMs });
    },
    take(key, text) {
      const item = pending.get(key);
      pending.delete(key);
      if (!item || item.expiresAt <= now()) return null;
      return { name: item.command, argument: String(text).slice(0, 1000), addressedToThisBot: true };
    }
  };
}
