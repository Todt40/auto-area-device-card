// auto-area-device-card
// Groups matching entities by area and renders one bubble-card button per
// entity. Reads the entity/area registries directly, so it rebuilds itself
// as devices and areas change instead of needing a fixed per-room config.
// Requires https://github.com/Clooos/Bubble-Card. Full config options: README.
(function () {
  class AutoAreaDeviceCard extends HTMLElement {
    setConfig(config) {
      const hasFilters = Array.isArray(config?.filters) && config.filters.length;
      const hasEntityIds = Array.isArray(config?.entity_ids);
      if (!hasFilters && !hasEntityIds) {
        throw new Error(
          'auto-area-device-card: either "filters" (a list of {domain, device_class?, button_type?}) or "entity_ids" (an explicit list of entity_ids) is required'
        );
      }
      this._filters = hasFilters ? config.filters : null;
      this._entityIds = hasEntityIds ? config.entity_ids : null;
      this._defaultButtonType = config.button_type || null;
      this._hiddenLabels = config.hidden_labels || ['hidden'];
      this._requireFloor = config.require_floor !== false;
      this._emptyText = config.empty_text || 'No devices found.';
      this._signature = null;
      this._groups = new Map(); // area_id -> Map(entityId -> bubble-card element)

      if (!this.shadowRoot) {
        this.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
          :host { display: block; }
          .group { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
          .group:last-child { margin-bottom: 0; }
          .group-header {
            font-size: 16px;
            font-weight: 600;
            color: var(--primary-text-color);
            padding: 4px 4px 0;
          }
          .group-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
            gap: 8px;
          }
          .empty { opacity: 0.6; padding: 8px 4px; }
        `;
        this.shadowRoot.appendChild(style);
        this._root = document.createElement('div');
        this.shadowRoot.appendChild(this._root);
      }
    }

    set hass(hass) {
      this._hass = hass;
      if (!hass || (!this._filters && !this._entityIds)) return;

      const matched = this._matchEntities(hass);
      // Rebuild the DOM only when which entities/areas match actually
      // changes, not on every state update.
      const signature = matched.map((m) => `${m.areaId}:${m.entityId}`).sort().join('|');

      if (signature !== this._signature) {
        this._signature = signature;
        this._rebuild(hass, matched);
      } else {
        for (const group of this._groups.values()) {
          for (const card of group.values()) card.hass = hass;
        }
      }
    }

    get hass() {
      return this._hass;
    }

    _matchEntities(hass) {
      const out = [];
      if (this._entityIds) {
        for (const entityId of this._entityIds) {
          if (!hass.states[entityId]) continue;
          if (this._isExcluded(hass, entityId)) continue;
          const areaId = this._entityArea(hass, entityId);
          if (!areaId) continue;
          const domain = entityId.slice(0, entityId.indexOf('.'));
          const buttonType = this._defaultButtonType || (domain === 'light' || domain === 'switch' ? 'switch' : 'state');
          out.push({ entityId, areaId, buttonType });
        }
        return out;
      }
      for (const entityId in hass.states) {
        const dot = entityId.indexOf('.');
        const domain = entityId.slice(0, dot);
        const attrs = hass.states[entityId].attributes;
        const filter = this._filters.find((f) => {
          if (f.domain && f.domain !== domain) return false;
          if (f.domains && !f.domains.includes(domain)) return false;
          if (f.exclude_domains && f.exclude_domains.includes(domain)) return false;
          if (f.device_class && attrs?.device_class !== f.device_class) return false;
          if (f.device_classes && !f.device_classes.includes(attrs?.device_class)) return false;
          if (f.exclude_device_classes && f.exclude_device_classes.includes(attrs?.device_class)) return false;
          if (f.exclude_platforms && f.exclude_platforms.includes(hass.entities?.[entityId]?.platform)) return false;
          return true;
        });
        if (!filter) continue;
        if (this._isExcluded(hass, entityId)) continue;
        const areaId = this._entityArea(hass, entityId);
        if (!areaId) continue;
        const buttonType = filter.button_type || (domain === 'light' || domain === 'switch' ? 'switch' : 'state');
        out.push({ entityId, areaId, buttonType });
      }
      return out;
    }

    _isExcluded(hass, entityId) {
      const domain = entityId.slice(0, entityId.indexOf('.'));
      if (domain === 'event' || domain === 'notify') return true;
      if (entityId.includes('browser_mod') || entityId.includes('zigbee2mqtt_bridge')) return true;
      const reg = hass.entities?.[entityId];
      if (reg) {
        if (reg.entity_category) return true;
        if (reg.platform === 'group') return true;
        if (reg.hidden_by || reg.disabled_by) return true;
      }
      return false;
    }

    _entityArea(hass, entityId) {
      const reg = hass.entities?.[entityId];
      if (!reg) return null;
      if (reg.area_id) return reg.area_id;
      const device = reg.device_id ? hass.devices?.[reg.device_id] : null;
      return device?.area_id || null;
    }

    _rebuild(hass, matched) {
      const byArea = new Map();
      for (const m of matched) {
        if (!byArea.has(m.areaId)) byArea.set(m.areaId, []);
        byArea.get(m.areaId).push(m);
      }

      const areas = Object.values(hass.areas || {})
        .filter((a) => byArea.has(a.area_id))
        .filter((a) => !a.labels?.some((l) => this._hiddenLabels.includes(l)))
        .filter((a) => !this._requireFloor || (a.floor_id && hass.floors?.[a.floor_id]))
        .sort((a, b) => a.name.localeCompare(b.name));

      this._root.textContent = '';
      this._groups = new Map();

      for (const area of areas) {
        const items = byArea.get(area.area_id).sort((x, y) => {
          const nx = hass.states[x.entityId]?.attributes?.friendly_name || x.entityId;
          const ny = hass.states[y.entityId]?.attributes?.friendly_name || y.entityId;
          return nx.localeCompare(ny);
        });

        const groupEl = document.createElement('div');
        groupEl.className = 'group';

        const header = document.createElement('div');
        header.className = 'group-header';
        header.textContent = area.name;
        groupEl.appendChild(header);

        const grid = document.createElement('div');
        grid.className = 'group-grid';
        groupEl.appendChild(grid);

        const itemMap = new Map();
        for (const { entityId, buttonType } of items) {
          const card = document.createElement('bubble-card');
          card.setConfig({
            type: 'custom:bubble-card',
            card_type: 'button',
            button_type: buttonType,
            entity: entityId,
            show_state: true,
            ...(buttonType === 'state' ? { tap_action: { action: 'more-info' } } : {}),
          });
          card.hass = hass;
          grid.appendChild(card);
          itemMap.set(entityId, card);
        }

        this._root.appendChild(groupEl);
        this._groups.set(area.area_id, itemMap);
      }

      if (areas.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = this._emptyText;
        this._root.appendChild(empty);
      }
    }

    getCardSize() {
      return 3;
    }
  }

  customElements.get('auto-area-device-card') || customElements.define('auto-area-device-card', AutoAreaDeviceCard);

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'auto-area-device-card',
    name: 'Auto Area Device Card',
    description: 'Groups matching entities by area and renders bubble-card buttons, auto-updating as devices/areas change.',
  });
})();
