
    const profile = BL.getProfile();
    if (!profile) { window.location.href = '/profiles.html'; }

    function val(id) { return document.getElementById(id).value.trim(); }
    function showResult(id, ok, msg) {
      const el = document.getElementById(id);
      el.textContent = msg;
      el.className = 'test-result ' + (ok ? 'ok' : 'err');
    }

    async function load() {
      try {
        const r = await fetch(`/api/users/${profile.id}`);
        if (!r.ok) { window.location.href = '/profiles.html'; return; }
        const d = await r.json();
        document.getElementById('display_name').value = d.user.display_name || '';
        document.getElementById('steam_input').value = d.user.steam_id || '';
        document.getElementById('discord_user_id').value = d.user.discord_user_id || '';
      } catch (err) {
        showResult('save-result', false, 'Load error: ' + err.message);
      }
    }

    async function testSteam() {
      const input = val('steam_input');
      if (!input) return showResult('steam-result', false, '✗ Enter a value');
      showResult('steam-result', true, 'Testing…');
      try {
        const r = await fetch('/api/users/resolve-steam', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ steam_input: input })
        });
        const d = await r.json();
        if (d.ok) showResult('steam-result', true, `✓ "${d.persona_name}" (${d.steam_id})`);
        else showResult('steam-result', false, '✗ ' + d.error);
      } catch (err) { showResult('steam-result', false, '✗ ' + err.message); }
    }

    async function save() {
      showResult('save-result', true, 'Saving…');
      try {
        const r = await fetch(`/api/users/${profile.id}`, {
          method:'PATCH', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            display_name: val('display_name'),
            steam_input: val('steam_input'),
            discord_user_id: val('discord_user_id')
          })
        });
        const d = await r.json();
        if (d.ok) {
          showResult('save-result', true, '✓ Saved');
          BL.setProfile(profile.id, val('display_name'));
        } else showResult('save-result', false, '✗ ' + (d.error || 'Save failed'));
      } catch (err) { showResult('save-result', false, '✗ ' + err.message); }
    }


    async function estimatePrices() {
      const btn = document.getElementById('estimate-prices-btn');
      btn.disabled = true;
      showResult('estimate-result', true, 'Estimating…');
      try {
        const r = await fetch(`/api/users/${profile.id}/estimate-prices`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ re_estimate: true })
        });
        const d = await r.json();
        if (d.ok) {
          const parts = [];
          if (d.updated) parts.push(`${d.updated} prices updated`);
          if (d.marked_free) parts.push(`${d.marked_free} marked free`);
          if (d.failed) parts.push(`${d.failed} not found`);
          showResult('estimate-result', true, '✓ ' + (parts.join(', ') || 'No changes needed'));
        } else {
          showResult('estimate-result', false, '✗ ' + (d.error || 'Estimate failed'));
        }
      } catch (err) {
        showResult('estimate-result', false, '✗ ' + err.message);
      } finally {
        btn.disabled = false;
      }
    }


    let licenseRows = [];
    let licenseStats = null;
    let currentLicenseMatchIdx = null;

    async function previewLicenses() {
      const raw = document.getElementById('licenses_raw').value;
      const preview = document.getElementById('licenses-preview');
      const applyBtn = document.getElementById('apply-licenses-btn');
      licenseRows = [];
      licenseStats = null;
      applyBtn.disabled = true;
      preview.innerHTML = '';
      if (!raw.trim()) return showResult('licenses-result', false, '✗ Paste your licences table first');
      showResult('licenses-result', true, 'Parsing…');
      try {
        const r = await fetch(`/api/users/${profile.id}/parse-licenses`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ raw_text: raw })
        });
        const d = await r.json();
        if (!r.ok || !d.ok) return showResult('licenses-result', false, '✗ ' + (d.error || 'Parse failed'));
        licenseStats = d.stats || {};
        licenseRows = (d.rows || []).map(row => ({
          raw_name: row.raw_name,
          acquisition_method: row.acquisition_method,
          app_id: row.match?.app_id || null,
          match_name: row.match?.name || null,
          auto_matched: !!row.match,
          manual_matched: false,
          skip: !row.match
        }));
        renderLicensePreview();
      } catch (err) { showResult('licenses-result', false, '✗ ' + err.message); }
    }

    function renderLicensePreview() {
      const preview = document.getElementById('licenses-preview');
      const applyBtn = document.getElementById('apply-licenses-btn');
      const matched = licenseRows.filter(r => r.app_id);
      const unmatched = licenseRows.filter(r => !r.app_id);
      const gifted = licenseRows.filter(r => r.acquisition_method === 'Gift/Guest Pass').length;
      const complimentary = licenseRows.filter(r => r.acquisition_method === 'Complimentary').length;
      showResult('licenses-result', true, `✓ Found ${licenseRows.length} free licence rows (${gifted} gifted, ${complimentary} complimentary) • ${matched.length} matched • ${unmatched.length} need matching`);
      applyBtn.disabled = matched.length === 0;

      preview.innerHTML = `
        <div class="license-preview-head">Free licence games to mark free</div>
        ${matched.length ? `<ul class="license-match-list">${matched.map((r, idx) => `
          <li>
            <div><strong>${escapeHtml(r.match_name)}</strong> <span class="muted">${escapeHtml(r.acquisition_method)} from “${escapeHtml(r.raw_name)}”${r.manual_matched ? ' • manually matched' : ''}</span></div>
            <button class="btn-test btn-sm" type="button" data-license-match-idx="${licenseRows.indexOf(r)}">Change match</button>
          </li>`).join('')}</ul>` : '<p>No matches found in this profile library yet.</p>'}
        ${unmatched.length ? `<details open><summary>${unmatched.length} free licence rows need matching</summary><ul class="license-match-list">${unmatched.map(r => `
          <li>
            <div><strong>${escapeHtml(r.raw_name)}</strong> <span class="muted">${escapeHtml(r.acquisition_method)}</span></div>
            <button class="btn-primary btn-sm" type="button" data-license-match-idx="${licenseRows.indexOf(r)}">Match</button>
          </li>`).join('')}</ul></details>` : ''}
      `;
      preview.querySelectorAll('[data-license-match-idx]').forEach(btn => {
        btn.addEventListener('click', () => openLicenseMatchModal(parseInt(btn.dataset.licenseMatchIdx, 10)));
      });
    }

    async function applyLicenses() {
      const rows = licenseRows.filter(r => r.app_id).map(r => ({ raw_name: r.raw_name, app_id: r.app_id, acquisition_method: r.acquisition_method }));
      if (!rows.length) return showResult('licenses-result', false, '✗ Nothing matched to apply');
      showResult('licenses-result', true, 'Applying…');
      try {
        const r = await fetch(`/api/users/${profile.id}/import-licenses`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ rows })
        });
        const d = await r.json();
        if (d.ok) showResult('licenses-result', true, `✓ Marked ${d.free || 0} games as free (${d.gifted || 0} gifted, ${d.complimentary || 0} complimentary)${d.unmatched ? ` • ${d.unmatched} still unmatched` : ''}`);
        else showResult('licenses-result', false, '✗ ' + (d.error || 'Import failed'));
      } catch (err) { showResult('licenses-result', false, '✗ ' + err.message); }
    }

    function openLicenseMatchModal(idx) {
      currentLicenseMatchIdx = idx;
      const row = licenseRows[idx];
      document.getElementById('license-match-raw').textContent = `${row.raw_name} — ${row.acquisition_method}`;
      document.getElementById('license-match-search').value = row.raw_name || '';
      document.getElementById('license-match-backdrop').style.display = 'block';
      searchLicenseLibrary();
      setTimeout(() => document.getElementById('license-match-search').focus(), 0);
    }

    function closeLicenseMatchModal() {
      document.getElementById('license-match-backdrop').style.display = 'none';
      currentLicenseMatchIdx = null;
    }

    async function searchLicenseLibrary() {
      const input = document.getElementById('license-match-search');
      const out = document.getElementById('license-match-results');
      const q = input.value.trim();
      out.innerHTML = '<div class="muted small">Searching…</div>';
      try {
        const r = await fetch(`/api/users/${profile.id}/library-search?q=${encodeURIComponent(q)}`);
        const d = await r.json();
        if (!d.games?.length) {
          out.innerHTML = `<div class="no-results">No matches. <a href="#" id="license-clear-search" class="link">Clear search to browse all games</a></div>`;
          document.getElementById('license-clear-search')?.addEventListener('click', e => { e.preventDefault(); input.value = ''; searchLicenseLibrary(); });
          return;
        }
        out.innerHTML = d.games.map(g => `<div class="modal-result" data-app-id="${g.app_id}" data-name="${escapeHtml(g.name)}">${escapeHtml(g.name)}</div>`).join('');
        out.querySelectorAll('.modal-result').forEach(div => {
          div.addEventListener('click', () => {
            if (currentLicenseMatchIdx === null) return;
            const row = licenseRows[currentLicenseMatchIdx];
            row.app_id = parseInt(div.dataset.appId, 10);
            row.match_name = div.textContent.trim();
            row.skip = false;
            row.manual_matched = true;
            closeLicenseMatchModal();
            renderLicensePreview();
          });
        });
      } catch (err) {
        out.innerHTML = `<div class="err">${escapeHtml(err.message)}</div>`;
      }
    }

    document.getElementById('license-match-search').addEventListener('input', searchLicenseLibrary);
    document.getElementById('license-match-cancel').addEventListener('click', closeLicenseMatchModal);
    document.getElementById('license-match-backdrop').addEventListener('click', e => { if (e.target.id === 'license-match-backdrop') closeLicenseMatchModal(); });

    function escapeHtml(s) {
      return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    async function deleteProfile() {
      const pw = val('admin_pw');
      if (!pw) return showResult('delete-result', false, '✗ Admin password required');
      if (!confirm('Really delete this profile? All game data for it will be lost.')) return;
      try {
        const r = await fetch(`/api/users/${profile.id}`, {
          method:'DELETE', headers: { 'x-admin-password': pw }
        });
        const d = await r.json();
        if (d.ok) {
          BL.clearProfile();
          window.location.href = '/profiles.html';
        } else showResult('delete-result', false, '✗ ' + (d.error || 'Delete failed'));
      } catch (err) { showResult('delete-result', false, '✗ ' + err.message); }
    }

    load();
  