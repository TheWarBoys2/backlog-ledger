// The Backlog Ledger — shared client helpers
// Manages the "selected profile" stored in a cookie + the global Recalculate XP button.

const BL = {
  COOKIE_NAME: 'bl_profile',

  setProfile(id, name) {
    const value = JSON.stringify({ id, name });
    // 90-day cookie, path=/ so all pages can read it
    document.cookie = `${this.COOKIE_NAME}=${encodeURIComponent(value)};path=/;max-age=${90 * 86400};SameSite=Lax`;
  },

  getProfile() {
    const match = document.cookie.match(new RegExp('(?:^|; )' + this.COOKIE_NAME + '=([^;]*)'));
    if (!match) return null;
    try { return JSON.parse(decodeURIComponent(match[1])); }
    catch { return null; }
  },

  clearProfile() {
    document.cookie = `${this.COOKIE_NAME}=;path=/;max-age=0`;
  },



  // ============== User setup help (global, top-left) ==============
  installHelpButton() {
    if (document.getElementById('bl-help-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'bl-help-btn';
    btn.className = 'help-fab';
    btn.type = 'button';
    btn.title = 'How to set up your ledger';
    btn.setAttribute('aria-label', 'Open help and setup guide');
    btn.textContent = '?';
    btn.addEventListener('click', () => this.openHelpModal());
    document.body.appendChild(btn);
  },

  openHelpModal() {
    let modal = document.getElementById('bl-help-modal-bg');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'bl-help-modal-bg';
      modal.className = 'modal-bg';
      modal.style.display = 'none';
      modal.innerHTML = `
        <div class="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="bl-help-title">
          <button class="help-close-x" type="button" id="bl-help-close-x" aria-label="Close help">×</button>
          <div class="help-modal-header">
            <div class="help-modal-kicker">Setup guide</div>
            <div class="help-modal-title" id="bl-help-title">How to set up your ledger</div>
            <div class="modal-sub">A quick guide for players: connect your Steam profile, import your purchase and licence history, then review anything the app cannot match automatically.</div>
          </div>
          <div class="help-modal-body">
            <div class="help-grid">
              <div class="help-card">
                <span class="help-step">1</span>
                <h3>Create or choose your profile</h3>
                <p>Select your profile, then open <strong>Profile tools</strong>. Add your Steam ID, Steam64 ID, or Steam profile URL and save it.</p>
              </div>

              <div class="help-card">
                <span class="help-step">2</span>
                <h3>Make Steam game details public</h3>
                <p>The app can only sync games that Steam allows it to see.</p>
                <ol>
                  <li>Open Steam → your profile → Edit Profile.</li>
                  <li>Go to Privacy Settings.</li>
                  <li>Set <strong>Game details</strong> to <strong>Public</strong>.</li>
                </ol>
              </div>

              <div class="help-card">
                <span class="help-step">3</span>
                <h3>Sync your Steam library</h3>
                <p>On the main ledger page, press <strong>↻ Sync</strong>. This imports your Steam games and playtime. Use it again whenever you want the ledger to refresh your hours.</p>
              </div>

              <div class="help-card">
                <span class="help-step">4</span>
                <h3>Import purchases and licences together</h3>
                <p>Open <strong>Profile tools → Ledger imports</strong>, then click <strong>Import purchases & licences</strong>. The import page has two paste boxes:</p>
                <ol>
                  <li><strong>Purchase history:</strong> Steam Account Details → View Purchase History.</li>
                  <li><strong>Licences / gifts:</strong> Steam Account Details → Licenses and Product Key Activations.</li>
                </ol>
                <p>You can paste one or both. The app reviews both sources together in one matching screen.</p>
              </div>

              <div class="help-card">
                <span class="help-step">5</span>
                <h3>Review matches</h3>
                <p>The review page tries to match Steam rows to games in your library. If something is wrong, you can change the match, split a package across several games, save a purchase row for later, or mark a licence row as <strong>No match needed</strong>.</p>
                <p>Your choices are remembered, so re-importing the same data should keep your previous matches and ignored rows. You can also open <strong>Profile tools → Saved import matches</strong> to edit or clear remembered choices without re-importing.</p>
              </div>

              <div class="help-card">
                <span class="help-step">6</span>
                <h3>How gifts and free games work</h3>
                <p><strong>Gift/Guest Pass</strong> licence rows become free and show the <strong>GIFTED</strong> label. <strong>Complimentary</strong> licence rows also become free and move to the Free section.</p>
                <p><strong>Retail</strong> licence rows are not treated as free. They still use the normal missing-price estimate flow unless you enter a price manually.</p>
                <p>If purchase history shows that you paid for a game, that paid price wins over a Complimentary licence row.</p>
              </div>

              <div class="help-card">
                <span class="help-step">7</span>
                <h3>Estimate missing prices</h3>
                <p>In <strong>Profile tools → Missing price estimates</strong>, you can estimate prices for games that still have no known cost. Estimated prices are marked with <strong>EST</strong>.</p>
              </div>

              <div class="help-card">
                <span class="help-step">8</span>
                <h3>Fix anything manually</h3>
                <p>Some Steam packages, DLC, bundles, renamed games, demos, and old keys will need manual correction. You can edit prices directly on the ledger, add notes, add custom games, mark a game completed early, or manage saved import matches from Profile tools.</p>
                <p>If a game is currently marked Free and you type in a real price, it becomes a normal paid ledger item again.</p>
              </div>

              <div class="help-card full">
                <span class="help-step">9</span>
                <h3>What the labels mean</h3>
                <table class="help-mini-table">
                  <thead><tr><th>Label</th><th>Meaning</th></tr></thead>
                  <tbody>
                    <tr><td><strong>EST</strong></td><td>The price is estimated rather than imported from purchase history.</td></tr>
                    <tr><td><strong>GIFTED</strong></td><td>The game came from a Steam Gift/Guest Pass and counts as free.</td></tr>
                    <tr><td><strong>Free</strong></td><td>No play debt is owed.</td></tr>
                    <tr><td><strong>Outstanding / Arrears</strong></td><td>You have not yet played enough hours for the price.</td></tr>
                    <tr><td><strong>Completed early</strong></td><td>You manually marked the game as done before reaching the full hour target.</td></tr>
                  </tbody>
                </table>
                <div class="help-actions">
                  <a class="tb-btn primary" href="/profile-edit.html">Open profile tools</a>
                  <a class="tb-btn" href="/index.html">Open ledger</a>
                </div>
              </div>
            </div>
            <div class="modal-actions">
              <button class="tb-btn primary" type="button" id="bl-help-close">Got it</button>
            </div>
          </div>
        </div>`
      document.body.appendChild(modal);
      modal.addEventListener('click', (ev) => {
        if (ev.target === modal) this.closeHelpModal();
      });
      modal.querySelector('#bl-help-close').addEventListener('click', () => this.closeHelpModal());
      modal.querySelector('#bl-help-close-x').addEventListener('click', () => this.closeHelpModal());
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') this.closeHelpModal();
      });
    }
    modal.style.display = 'flex';
  },

  closeHelpModal() {
    const modal = document.getElementById('bl-help-modal-bg');
    if (modal) modal.style.display = 'none';
  },
  // ============== Recalculate XP button (global, top-right of every page) ==============
  installRecalcButton() {
    // Don't install on setup/profile-picker pages
    const skipPaths = ['/setup.html', '/profiles.html'];
    if (skipPaths.some(p => window.location.pathname.startsWith(p))) return;
    if (document.getElementById('bl-recalc-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'bl-recalc-btn';
    btn.innerHTML = '⚡ Recalculate XP';
    btn.title = 'Sync all profiles and recalculate XP from the latest playtime';
    btn.style.cssText = `
      position: fixed; top: 12px; right: 16px; z-index: 200;
      font-family: 'JetBrains Mono', monospace; font-size: 10px;
      letter-spacing: 0.18em; text-transform: uppercase;
      padding: 8px 12px; background: rgba(19, 17, 17, 0.95);
      border: 1px solid rgba(212, 166, 74, 0.5); color: #d4a64a;
      cursor: pointer; backdrop-filter: blur(4px);
      transition: all 0.15s;
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.borderColor = '#d4a64a';
      btn.style.background = '#d4a64a';
      btn.style.color = '#131111';
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.disabled) {
        btn.style.borderColor = 'rgba(212, 166, 74, 0.5)';
        btn.style.background = 'rgba(19, 17, 17, 0.95)';
        btn.style.color = '#d4a64a';
      }
    });
    btn.addEventListener('click', () => this.recalculateXp(btn));
    document.body.appendChild(btn);
  },

  async recalculateXp(btn) {
    const original = btn.innerHTML;
    const adminPassword = window.prompt('Admin password required to sync all profiles and recalculate XP:');
    if (!adminPassword) return;
    btn.disabled = true;
    btn.innerHTML = '⚡ Syncing…';
    btn.style.opacity = '0.7';
    try {
      const r = await fetch('/api/recalculate-xp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
        body: JSON.stringify({ sync: true })
      });
      const d = await r.json();
      if (!d.ok) {
        btn.innerHTML = '⚠ Failed';
        setTimeout(() => { btn.innerHTML = original; btn.disabled = false; btn.style.opacity = '1'; }, 2500);
        return;
      }
      btn.innerHTML = `✓ ${d.synced.length} synced`;
      btn.style.color = '#b9d066';
      btn.style.borderColor = '#b9d066';
      // Fire a custom event so each page can react (reload its data)
      window.dispatchEvent(new CustomEvent('bl:xp-recalculated', { detail: d }));
      setTimeout(() => {
        btn.innerHTML = original;
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.color = '#d4a64a';
        btn.style.borderColor = 'rgba(212, 166, 74, 0.5)';
      }, 2500);
    } catch (err) {
      btn.innerHTML = '⚠ ' + (err.message || 'Failed').slice(0, 20);
      setTimeout(() => { btn.innerHTML = original; btn.disabled = false; btn.style.opacity = '1'; }, 2500);
    }
  }
};

// Auto-install on every page that loads this script
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { BL.installHelpButton(); BL.installRecalcButton(); });
  } else {
    BL.installHelpButton();
    BL.installRecalcButton();
  }
}
