import { describe, expect, it } from 'vitest';
import { WheelLayoutManager } from '../src/layout/WheelLayoutManager.js';

describe('WheelLayoutManager', () => {
  describe('slot allocation', () => {
    it('assigns first pane to slot 0', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      expect(wheel.addPane('p1')).toBe(0);
    });

    it('fills row-major order', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      const slots = ['p1','p2','p3','p4','p5'].map(id => wheel.addPane(id));
      expect(slots).toEqual([0, 1, 2, 3, 4]);
    });

    it('returns -1 when full', () => {
      const wheel = new WheelLayoutManager({ rows: 1, columns: 2 });
      wheel.addPane('p1'); wheel.addPane('p2');
      expect(wheel.addPane('p3')).toBe(-1);
    });

    it('reports capacity', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      expect(wheel.capacity).toBe(8);
    });
  });

  describe('removal and shifting', () => {
    it('shifts subsequent panes down', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      wheel.addPane('p1'); wheel.addPane('p2'); wheel.addPane('p3');
      wheel.removePane('p1');
      expect(wheel.getPaneAtSlot(0)).toBe('p2');
      expect(wheel.getPaneAtSlot(1)).toBe('p3');
      expect(wheel.getPaneAtSlot(2)).toBeNull();
    });

    it('tracks filled count', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      wheel.addPane('p1'); wheel.addPane('p2');
      expect(wheel.filledSlots).toBe(2);
      wheel.removePane('p1');
      expect(wheel.filledSlots).toBe(1);
    });
  });

  describe('overflow queue', () => {
    it('queues overflow FIFO', () => {
      const wheel = new WheelLayoutManager({ rows: 1, columns: 2 });
      wheel.addPane('p1'); wheel.addPane('p2');
      wheel.addPane('p3'); wheel.addPane('p4');
      expect(wheel.overflowQueue).toEqual(['p3', 'p4']);
    });

    it('auto-fills from overflow on removal', () => {
      const wheel = new WheelLayoutManager({ rows: 1, columns: 2 });
      wheel.addPane('p1'); wheel.addPane('p2'); wheel.addPane('p3');
      wheel.removePane('p1');
      expect(wheel.getPaneAtSlot(0)).toBe('p2');
      expect(wheel.getPaneAtSlot(1)).toBe('p3');
      expect(wheel.overflowQueue).toEqual([]);
    });
  });

  describe('geometry', () => {
    it('calculates pane dimensions', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      const geo = wheel.calculateGeometry(200, 40, 40);
      expect(geo.paneWidth).toBeGreaterThan(30);
      expect(geo.paneHeight).toBeGreaterThan(10);
      expect(geo.columns).toBe(4);
      expect(geo.rows).toBe(2);
    });
  });

  describe('split pane exclusion', () => {
    it('split panes cannot be removed', () => {
      const wheel = new WheelLayoutManager({ rows: 2, columns: 4 });
      wheel.addPane('p1'); wheel.addPane('p2');
      wheel.markAsSplit('p1');
      wheel.removePane('p1');
      expect(wheel.getPaneAtSlot(0)).toBe('p1');
    });
  });
});
