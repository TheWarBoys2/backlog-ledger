
    const profile = BL.getProfile();
    if (!profile) { window.location.href = '/profiles.html'; }

    let importRows = [];
    let purchaseStats = null;
    let licenseStats = null;
    let currentModalIdx = null;
    let currentMode = 'single';
    let bundleSelections = [];

    const $ = id => document.getElementById(id);
    const escHtml = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const showResult = (id, ok, msg) => { const el = $(id); el.textContent = msg; el.className = 'test-result ' + (ok ? 'ok' : 'err'); };
    const money = c => '£' + ((Number(c) || 0) / 100).toFixed(2);

    $('btn-parse').addEventListener('click', async () => {
      const purchaseText = $('purchase-raw').value.trim();
      const licenseText = $('license-raw').value.trim();
      if (!purchaseText && !licenseText) return showResult('parse-result', false, '✗ Paste purchase history, licences, or both first');
      showResult('parse-result', true, 'Parsing…');
      importRows = []; purchaseStats = null; licenseStats = null;

      try {
        if (purchaseText) {
          const r = await fetch(`/api/users/${profile.id}/parse-history`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw_text: purchaseText })
          });
          const d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d.error || 'Purchase history parse failed');
          purchaseStats = d.stats || {};
          importRows.push(...(d.rows || []).map(row => ({ ...row, import_kind: 'purchase' })));
        }

        if (licenseText) {
          const r = await fetch(`/api/users/${profile.id}/parse-licenses`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw_text: licenseText })
          });
          const d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d.error || 'Licence parse failed');
          licenseStats = d.stats || {};
          importRows.push(...(d.rows || []).map(row => ({
            import_kind: 'license',
            raw_name: row.raw_name,
            acquisition_method: row.acquisition_method,
            match: row.match || null,
            original_match: row.match || null,
            override_app_id: null,
            override_name: null,
            bundle_app_ids: null,
            bundle_names: null,
            skip: false,
            skip_reason: null
          })));
        }

        showResult('parse-result', true, '');
        renderPreview();
      } catch (err) {
        showResult('parse-result', false, '✗ ' + err.message);
      }
    });

    function isMatched(row) { return !!(row.match?.app_id || row.override_app_id || row.bundle_app_ids?.length || row.custom_name); }
    function isUnmatched(row) { return !row.skip && !isMatched(row); }

    function renderPreview() {
      const purchases = importRows.filter(r => r.import_kind === 'purchase');
      const licences = importRows.filter(r => r.import_kind === 'license');
      const active = importRows.filter(r => !r.skip);
      const matched = active.filter(isMatched);
      const unmatched = active.filter(isUnmatched);
      const skipped = importRows.filter(r => r.skip && r.import_kind === 'purchase');
      const ignored = importRows.filter(r => r.skip && r.import_kind === 'license');

      const parts = [];
      if (purchaseStats) {
        parts.push(`<strong>${purchaseStats.totalTx}</strong> transactions • <strong>${purchaseStats.purchases}</strong> purchases • <strong>£${Number(purchaseStats.totalSpent || 0).toFixed(2)}</strong> spent`);
      }
      if (licenseStats) {
        parts.push(`<strong>${licenseStats.total_rows || 0}</strong> licence rows • <strong>${licenseStats.gifted || 0}</strong> gifted • <strong>${licenseStats.complimentary || 0}</strong> complimentary`);
      }
      $('preview-stats').innerHTML = `${parts.join('<br>')}<br>
        Review contains <strong>${purchases.length}</strong> purchase rows and <strong>${licences.length}</strong> free licence rows •
        <strong class="ok">${matched.length}</strong> matched •
        <strong class="warn">${unmatched.length}</strong> need matching •
        <strong>${skipped.length}</strong> skipped •
        <strong>${ignored.length}</strong> ignored/no match needed`;
      renderTable();
    }

    function renderTable() {
      const filter = $('filter-input').value.toLowerCase().trim();
      const kind = $('filter-kind').value;
      const status = $('filter-status').value;

      const groupTotals = new Map();
      for (const row of importRows) {
        if (row.import_kind !== 'purchase' || row.skip) continue;
        const appId = row.override_app_id || row.match?.app_id;
        if (!appId) continue;
        const name = row.override_name || row.match?.name || '';
        if (!groupTotals.has(appId)) groupTotals.set(appId, { total_cents: 0, count: 0, name });
        const g = groupTotals.get(appId);
        g.total_cents += row.total_cents || 0;
        g.count += 1;
      }

      let display = importRows.map((row, idx) => ({ row, idx }));
      if (kind !== 'all') display = display.filter(x => x.row.import_kind === kind);
      if (status === 'matched') display = display.filter(x => !x.row.skip && isMatched(x.row));
      else if (status === 'unmatched') display = display.filter(x => isUnmatched(x.row));
      else if (status === 'skipped') display = display.filter(x => x.row.skip && x.row.import_kind === 'purchase');
      else if (status === 'ignored') display = display.filter(x => x.row.skip && x.row.import_kind === 'license');
      else display = [...display.filter(x => !x.row.skip), ...display.filter(x => x.row.skip)];
      if (filter) display = display.filter(x => (x.row.raw_name || '').toLowerCase().includes(filter) || (x.row.override_name || x.row.match?.name || '').toLowerCase().includes(filter));

      const multiGroups = [...groupTotals.entries()].filter(([, g]) => g.count > 1);
      let summaryHtml = '';
      if (multiGroups.length > 0) {
        summaryHtml = `<div class="card" style="background:var(--bg);margin-bottom:1rem;padding:0.75rem 1rem;">
          <strong>Multiple purchase entries combined into one game:</strong>
          <ul style="margin:0.4rem 0 0 1.2rem;font-size:0.9rem;">${multiGroups.map(([, g]) => `<li><strong>${escHtml(g.name)}</strong> — ${g.count} entries totalling <strong>${money(g.total_cents)}</strong></li>`).join('')}</ul>
        </div>`;
      }

      let html = `<table class="sync-table"><thead><tr><th>Import row</th><th>Effect</th><th>Match</th><th></th></tr></thead><tbody>`;
      display.forEach(({ row, idx }) => {
        const rawName = row.raw_name || '—';
        const label = row.import_kind === 'purchase' ? '<span class="estimated-flag">PURCHASE</span>' : '<span class="gifted-flag">FREE LICENCE</span>';
        let effect = row.import_kind === 'purchase' ? money(row.total_cents || 0) : escHtml(row.acquisition_method || 'Free');
        let matchCell = '';
        let actionsHtml = '';

        if (row.skip) {
          matchCell = `<span class="muted">— ${escHtml(row.skip_reason || 'Skipped')}</span>`;
          actionsHtml = row.import_kind === 'license'
            ? `<button class="btn-test btn-sm" data-idx="${idx}" data-action="restore">Restore</button>`
            : '';
        } else if (row.bundle_app_ids?.length) {
          matchCell = `<span class="ok">✓ ${row.import_kind === 'license' ? 'Package' : 'Bundle'} of ${row.bundle_app_ids.length}: ${row.bundle_names.map(escHtml).join(', ')}</span>`;
          actionsHtml = `<button class="btn-test btn-sm" data-idx="${idx}" data-action="match">Change</button>${row.import_kind === 'license' ? ` <button class="btn-danger btn-sm" data-idx="${idx}" data-action="remove-match">Remove match</button>` : ''}`;
        } else if (row.override_app_id || row.match?.app_id) {
          const appId = row.override_app_id || row.match.app_id;
          const matchedName = row.override_name || row.match.name;
          const group = row.import_kind === 'purchase' ? groupTotals.get(appId) : null;
          const groupNote = group && group.count > 1 ? ` <span class="muted">→ adds to ${money(group.total_cents)} total</span>` : '';
          matchCell = `<span class="ok">✓ ${escHtml(matchedName)}${groupNote}</span>`;
          actionsHtml = `<button class="btn-test btn-sm" data-idx="${idx}" data-action="match">Change</button>${row.import_kind === 'license' ? ` <button class="btn-danger btn-sm" data-idx="${idx}" data-action="remove-match">Remove match</button>` : ''}`;
        } else if (row.custom_name) {
          matchCell = `<span class="warn">→ pending: ${escHtml(row.custom_name)}</span>`;
          actionsHtml = `<button class="btn-test btn-sm" data-idx="${idx}" data-action="match">Change</button>`;
        } else {
          matchCell = `<span class="warn">⚠ Needs matching</span>`;
          actionsHtml = `<button class="btn-test btn-sm" data-idx="${idx}" data-action="match">Match</button>${row.import_kind === 'license' ? ` <button class="btn-test btn-sm" data-idx="${idx}" data-action="remove-match">No match needed</button>` : ''}`;
        }

        html += `<tr class="${row.skip ? 'row-skipped' : ''}">
          <td>${label}<br>${escHtml(rawName)}${row.count > 1 ? ` <span class="muted">(${row.count}×)</span>` : ''}</td>
          <td>${row.import_kind === 'purchase' && !row.skip ? `<input class="price-input" type="number" step="0.01" min="0" data-idx="${idx}" value="${((row.total_cents || 0) / 100).toFixed(2)}" />` : effect}</td>
          <td>${matchCell}</td>
          <td>${actionsHtml}</td>
        </tr>`;
      });
      html += '</tbody></table>';

      $('step-paste').style.display = 'none';
      $('step-preview').style.display = 'block';
      $('preview-table').innerHTML = summaryHtml + html;

      document.querySelectorAll('[data-action="match"]').forEach(btn => btn.addEventListener('click', () => openModal(parseInt(btn.dataset.idx, 10))));
      document.querySelectorAll('[data-action="remove-match"]').forEach(btn => btn.addEventListener('click', () => removeLicenseMatch(parseInt(btn.dataset.idx, 10))));
      document.querySelectorAll('[data-action="restore"]').forEach(btn => btn.addEventListener('click', () => restoreLicenseRow(parseInt(btn.dataset.idx, 10))));
      document.querySelectorAll('.price-input').forEach(inp => inp.addEventListener('change', () => {
        const idx = parseInt(inp.dataset.idx, 10);
        importRows[idx].total_cents = Math.round(parseFloat(inp.value || 0) * 100);
        renderPreview();
      }));
    }

    $('filter-input').addEventListener('input', renderTable);
    $('filter-kind').addEventListener('change', renderTable);
    $('filter-status').addEventListener('change', renderTable);

    function smartSearchPrefill(row) {
      const rawName = row.raw_name || '';
      let s = String(rawName).replace(/[™®©]/g, '');
      if (row.import_kind === 'license') {
        s = s.replace(/\s+Limited Free Promotional Package\s*-\s*.+$/i, '')
          .replace(/\s+Free Promotional Package\s*-\s*.+$/i, '')
          .replace(/\s+for store signup.*$/i, '')
          .replace(/\s+for playtesters.*$/i, '')
          .replace(/\s+-\s*Beta Testing.*$/i, '')
          .replace(/\b(gift copy for.*|released)\b/gi, '');
      }
      return s.replace(/\s+-\s+.*$/i, '').replace(/:\s+.*$/i, '')
        .replace(/\b(standard|deluxe|ultimate|complete|definitive|enhanced|remastered|edition|pack|bundle|goty|gold|platinum|collection|launch|legacy|classic|preorder|pre-purchase|game of the year|anniversary|gift sent to.*|row|ww|uk|eu)\b/gi, '')
        .trim().split(/\s+/).slice(0, 3).join(' ');
    }

    function openModal(idx) {
      currentModalIdx = idx;
      const row = importRows[idx];
      const isLicence = row.import_kind === 'license';
      $('modal-title').textContent = isLicence ? 'Match licence row' : 'Match purchase row';
      $('modal-raw-name').textContent = isLicence
        ? `Licence: "${row.raw_name}" — ${row.acquisition_method}`
        : `Receipt: "${row.raw_name}" — ${money(row.total_cents || 0)}`;
      $('single-help').textContent = isLicence ? 'Pick the game this licence entry should mark as free.' : 'Pick the game this purchase should be matched to.';
      $('bundle-help').textContent = isLicence ? 'Pick multiple games if this licence row represents a package. Every selected game will be marked free.' : 'Pick multiple games to split this purchase price between.';
      document.querySelectorAll('.purchase-only').forEach(el => el.style.display = isLicence ? 'none' : 'inline-block');

      bundleSelections = row.bundle_app_ids ? row.bundle_app_ids.map((id, i) => ({ app_id: id, name: row.bundle_names[i] })) : [];
      let startMode = row.bundle_app_ids?.length ? 'bundle' : 'single';
      if (!isLicence && row.link_dlc) startMode = 'dlc';
      if (!isLicence && row.custom_name) startMode = 'pending';
      $('search-single').value = smartSearchPrefill(row);
      $('search-bundle').value = '';
      $('search-dlc').value = '';
      $('custom-name').value = row.custom_name || '';
      switchMode(startMode);
      $('modal-backdrop').style.display = 'flex';
    }
    const closeModal = () => { $('modal-backdrop').style.display = 'none'; currentModalIdx = null; };

    function switchMode(mode) {
      const row = importRows[currentModalIdx];
      if (row?.import_kind === 'license' && (mode === 'dlc' || mode === 'pending')) mode = 'single';
      currentMode = mode;
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
      document.querySelectorAll('.mode-panel').forEach(p => p.style.display = 'none');
      $(`panel-${mode}`).style.display = 'block';
      if (mode === 'single') doSearch('single');
      if (mode === 'bundle') { doSearch('bundle'); renderBundleSelected(); }
      if (mode === 'dlc') doSearch('dlc');
    }
    document.querySelectorAll('.mode-tab').forEach(tab => tab.addEventListener('click', () => switchMode(tab.dataset.mode)));

    async function doSearch(mode) {
      const input = $(`search-${mode}`);
      const out = $(`results-${mode}`);
      const q = input.value.trim();
      try {
        const r = await fetch(`/api/users/${profile.id}/library-search?q=${encodeURIComponent(q)}`);
        const d = await r.json();
        if (!d.games?.length) {
          out.innerHTML = `<div class="no-results">No matches. <a href="#" id="clear-${mode}" class="link">Clear search to browse all games</a></div>`;
          $(`clear-${mode}`)?.addEventListener('click', e => { e.preventDefault(); input.value = ''; doSearch(mode); });
          return;
        }
        out.innerHTML = d.games.map(g => {
          const isSelected = mode === 'bundle' && bundleSelections.some(s => s.app_id === g.app_id);
          return `<div class="modal-result ${isSelected ? 'selected' : ''}" data-app-id="${g.app_id}" data-name="${escHtml(g.name)}">${escHtml(g.name)}${isSelected ? ' <span class="ok">✓</span>' : ''}</div>`;
        }).join('');
        out.querySelectorAll('.modal-result').forEach(div => div.addEventListener('click', () => handleResultClick(mode, parseInt(div.dataset.appId, 10), div.dataset.name)));
      } catch {}
    }
    $('search-single').addEventListener('input', () => doSearch('single'));
    $('search-bundle').addEventListener('input', () => doSearch('bundle'));
    $('search-dlc').addEventListener('input', () => doSearch('dlc'));

    function handleResultClick(mode, appId, name) {
      if (currentModalIdx === null) return;
      const row = importRows[currentModalIdx];
      if (mode === 'single') {
        clearRow(row);
        row.override_app_id = appId; row.override_name = name; row.skip = false; row.skip_reason = null;
        closeModal(); renderPreview();
      } else if (mode === 'dlc') {
        clearRow(row);
        row.override_app_id = appId; row.override_name = name; row.link_dlc = true;
        closeModal(); renderPreview();
      } else if (mode === 'bundle') {
        const existing = bundleSelections.findIndex(s => s.app_id === appId);
        if (existing >= 0) bundleSelections.splice(existing, 1);
        else bundleSelections.push({ app_id: appId, name });
        renderBundleSelected(); doSearch('bundle');
      }
    }

    function clearRow(row) {
      row.override_app_id = null; row.override_name = null;
      row.link_dlc = false; row.custom_name = null;
      row.bundle_app_ids = null; row.bundle_names = null;
    }

    function removeLicenseMatch(idx) {
      const row = importRows[idx];
      if (!row || row.import_kind !== 'license') return;
      clearRow(row); row.match = null; row.skip = true; row.skip_reason = 'No match needed';
      renderPreview();
    }
    function restoreLicenseRow(idx) {
      const row = importRows[idx];
      if (!row || row.import_kind !== 'license') return;
      row.skip = false; row.skip_reason = null; row.match = row.original_match || null;
      renderPreview();
    }

    function renderBundleSelected() {
      const row = importRows[currentModalIdx];
      const out = $('bundle-selected');
      if (!bundleSelections.length) {
        out.innerHTML = '<p class="muted small">No games selected yet. Pick at least 2.</p>';
        return;
      }
      const isLicence = row?.import_kind === 'license';
      const splitCents = Math.round((row?.total_cents || 0) / bundleSelections.length);
      out.innerHTML = `<strong>Selected (${bundleSelections.length}):</strong>
        <div class="bundle-tags">${bundleSelections.map((s, i) => `<span class="bundle-tag">${escHtml(s.name)}<button data-idx="${i}" class="bundle-remove">×</button></span>`).join('')}</div>
        <button class="btn-primary" id="btn-save-bundle" ${bundleSelections.length < 2 ? 'disabled' : ''} style="margin-top:0.75rem;">
          ${isLicence ? 'Mark all selected games free' : `Apply bundle (${bundleSelections.length} games, ${money(splitCents)} each)`}
        </button>`;
      out.querySelectorAll('.bundle-remove').forEach(btn => btn.addEventListener('click', () => {
        bundleSelections.splice(parseInt(btn.dataset.idx, 10), 1); renderBundleSelected(); doSearch('bundle');
      }));
      $('btn-save-bundle')?.addEventListener('click', () => {
        if (bundleSelections.length < 2) return;
        const row = importRows[currentModalIdx];
        clearRow(row); row.skip = false; row.skip_reason = null;
        row.bundle_app_ids = bundleSelections.map(s => s.app_id);
        row.bundle_names = bundleSelections.map(s => s.name);
        closeModal(); renderPreview();
      });
    }

    $('btn-save-pending').addEventListener('click', () => {
      if (currentModalIdx === null) return;
      const row = importRows[currentModalIdx];
      if (row.import_kind === 'license') return;
      const custom = $('custom-name').value.trim();
      clearRow(row); row.custom_name = custom || null;
      closeModal(); renderPreview();
    });
    $('btn-cancel-modal').addEventListener('click', closeModal);
    $('modal-backdrop').addEventListener('click', e => { if (e.target.id === 'modal-backdrop') closeModal(); });

    $('btn-import').addEventListener('click', async () => {
      const purchaseRows = importRows.filter(r => r.import_kind === 'purchase');
      const licenseRows = importRows.filter(r => r.import_kind === 'license');
      showResult('import-result', true, 'Saving…');
      const summaries = [];
      try {
        if (purchaseRows.length) {
          const toImport = purchaseRows.map(row => {
            if (row.skip) return { skip: true };
            if (row.bundle_app_ids?.length) return { skip: false, bundle_app_ids: row.bundle_app_ids, paid_cents: row.total_cents, raw_name: row.raw_name };
            const appId = row.override_app_id || row.match?.app_id || null;
            return { skip: false, app_id: appId, raw_name: row.raw_name, custom_name: row.custom_name || null, link_dlc: !!row.link_dlc, paid_cents: row.total_cents };
          });
          const r = await fetch(`/api/users/${profile.id}/import-history`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: toImport })
          });
          const d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d.error || 'Purchase import failed');
          summaries.push(`<strong>${d.saved}</strong> game prices saved.`);
          if (d.dlc_linked) summaries.push(`<strong>${d.dlc_linked}</strong> DLC/package prices added to base games.`);
          if (d.pending) summaries.push(`<strong>${d.pending}</strong> purchase rows saved as pending.`);
          if (d.skipped) summaries.push(`<strong>${d.skipped}</strong> purchase rows skipped.`);
        }
        if (licenseRows.length) {
          const toImport = licenseRows.map(row => {
            if (row.skip) return { skip: true, raw_name: row.raw_name, acquisition_method: row.acquisition_method };
            if (row.bundle_app_ids?.length) return { skip: false, bundle_app_ids: row.bundle_app_ids, raw_name: row.raw_name, acquisition_method: row.acquisition_method };
            const appId = row.override_app_id || row.match?.app_id || null;
            return { skip: false, app_id: appId, raw_name: row.raw_name, acquisition_method: row.acquisition_method };
          });
          const r = await fetch(`/api/users/${profile.id}/import-licenses`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: toImport })
          });
          const d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d.error || 'Licence import failed');
          summaries.push(`<strong>${d.free || 0}</strong> games marked free from licences.`);
          summaries.push(`<strong>${d.gifted || 0}</strong> gifted • <strong>${d.complimentary || 0}</strong> complimentary/free.`);
          if (d.unmatched) summaries.push(`<strong>${d.unmatched}</strong> licence rows still need matching.`);
        }
        $('step-preview').style.display = 'none';
        $('step-done').style.display = 'block';
        $('done-summary').innerHTML = summaries.join('<br>') || 'Nothing to import.';
      } catch (err) { showResult('import-result', false, '✗ ' + err.message); }
    });

    $('btn-reset').addEventListener('click', () => {
      $('step-preview').style.display = 'none';
      $('step-paste').style.display = 'block';
      importRows = []; purchaseStats = null; licenseStats = null;
    });
  