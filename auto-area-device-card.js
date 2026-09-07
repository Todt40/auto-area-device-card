// area-device-list-card
//
// Groups matching entities by area and renders one bubble-card button per
// entity, with an area-name header per group — derived from the entity/
// area registries at render time, so new devices show up automatically
// with no config changes.
//
// Requires https://github.com/Clooos/Bubble-Card (bubble-card) to be
// installed — this card renders its buttons as bubble-card elements.
//
// Config:
//   type: custom:area-device-list-card
//   filters:
//     - domain: light
//       button_type: switch        # optional, default: switch for
//                                   # light/switch, state otherwise
//     - domain: binary_sensor
//       device_class: motion       # optional
//     - domains: [sensor, binary_sensor]  # optional, "any of these
//                                          # domains" (plural form of domain)
//     - domain: binary_sensor
//       device_classes: [door, garage_door, window, opening]  # optional,
//                                          # plural form of device_class
//     - domain: binary_sensor
//       exclude_device_classes: [motion, door]  # optional, catch-all minus
//                                                # specific device_classes
//     - domains: [sensor, binary_sensor]
//       exclude_platforms: [template, threshold, min_max]  # optional, tells
//                                          # a real hardware sensor apart
//                                          # from a computed/helper one via
//                                          # the entity registry's `platform`
//     - exclude_domains: [light, switch, camera] # omit "domain"/"domains"
//                                                  # for "any domain except these"
//   hidden_labels: [hidden]        # optional, area labels that hide that
//                                   # area's group entirely (default: [hidden])
//   require_floor: true            # optional, default true — drops areas
//                                   # with no floor assigned (network
//                                   # closets, admin/technical groupings
//                                   # that aren't real rooms)
//   empty_text: "No devices found." # optional
//
// Entities matching ANY filter are included (first match wins). Excluded
// automatically: event/notify domains, browser_mod/zigbee2mqtt bridge
// entities, helper group entities, and anything with an entity_category or
// that's hidden/disabled in the entity registry.
//
// Alternatively, instead of `filters:`, pass an explicit list:
//   type: custom:area-device-list-card
//   entity_ids: [light.kitchen, switch.coffee_maker]
//   button_type: state   # optional, default: switch for light/switch,
//                         # state otherwise
// Use this when the caller has already resolved exactly which entities
// belong on the card (e.g. to implement first-match-wins across several
// cards, which this card's own per-card filter matching can't do by
// itself). Excluded/hidden/area-grouping behavior is identical either way.
(function () {
  class AreaDeviceListCard extends HTMLElement {
    setConfig(config) {
      const hasFilters = Array.isArray(config?.filters) && config.filters.length;
      const hasEntityIds = Array.isArray(config?.entity_ids);
      if (!hasFilters && !hasEntityIds) {
        throw new Error(
          'area-device-list-card: either "filters" (a list of {domain, device_class?, button_type?}) or "entity_ids" (an explicit list of entity_ids) is required'
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

  customElements.get('area-device-list-card') || customElements.define('area-device-list-card', AreaDeviceListCard);

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'area-device-list-card',
    name: 'Area Device List Card',
    description: 'Groups matching entities by area and renders bubble-card buttons, auto-updating as devices/areas change.',
  });
})();
