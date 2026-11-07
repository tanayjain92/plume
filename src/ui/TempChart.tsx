import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { TempSample } from './history';
import { tempToDisplay, type UnitSystem } from './units';

/** Room time as m:ss, or h:mm past an hour. */
export function fmtClock(t: number): string {
  const s = Math.round(t);
  if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} h`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const COLORS = { mean: '#e7e9ee', floor: '#67a9cf', ceiling: '#ef8a62', outdoor: '#9097a7', setpoint: '#5aa9ff' };

/** Live chart of room temperature over room time (average, floor, ceiling, outdoor, setpoint). */
export function TempChart(props: { samples: TempSample[]; version: number; units: UnitSystem }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const { units } = props;

  // Build the plot (again when units change, since labels change).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const deg = units === 'imperial' ? '°F' : '°C';
    const fmt = (v: number | null) => (v == null ? '–' : `${v.toFixed(1)}${deg}`);
    const axis = { stroke: '#9097a7', grid: { stroke: '#2e3340', width: 1 }, ticks: { stroke: '#2e3340', width: 1 } };
    const plot = new uPlot(
      {
        width: Math.max(200, el.clientWidth),
        height: 220,
        legend: { live: true },
        cursor: { drag: { x: false, y: false } },
        scales: { x: { time: false } },
        axes: [
          { ...axis, incrs: [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400], label: 'room time', labelSize: 18, values: (_, ticks) => ticks.map(fmtClock) },
          { ...axis, values: (_, ticks) => ticks.map((t) => `${t.toFixed(0)}°`), size: 44 },
        ],
        series: [
          { label: 'Room time', value: (_, v) => (v == null ? '–' : fmtClock(v)) },
          { label: 'Average', stroke: COLORS.mean, width: 2, points: { show: false }, value: (_, v) => fmt(v) },
          { label: 'Floor', stroke: COLORS.floor, width: 1, points: { show: false }, value: (_, v) => fmt(v) },
          { label: 'Ceiling', stroke: COLORS.ceiling, width: 1, points: { show: false }, value: (_, v) => fmt(v) },
          { label: 'Outdoor', stroke: COLORS.outdoor, width: 1, dash: [6, 4], points: { show: false }, value: (_, v) => fmt(v) },
          { label: 'Setpoint', stroke: COLORS.setpoint, width: 1, dash: [3, 3], points: { show: false }, value: (_, v) => fmt(v) },
        ],
      },
      [[], [], [], [], [], []],
      el,
    );
    plotRef.current = plot;
    const ro = new ResizeObserver(() => plot.setSize({ width: Math.max(200, el.clientWidth), height: 220 }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [units]);

  // Push new data (the parent bumps `version` when samples change).
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const s = props.samples;
    const d = (c: number) => tempToDisplay(c, units);
    plot.setData([
      s.map((p) => p.t),
      s.map((p) => d(p.mean)),
      s.map((p) => d(p.floor)),
      s.map((p) => d(p.ceiling)),
      s.map((p) => d(p.outdoor)),
      s.map((p) => (p.setpoint === undefined ? null : d(p.setpoint))),
    ] as uPlot.AlignedData);
  }, [props.samples, props.version, units]);

  return <div ref={wrapRef} className="temp-chart" />;
}
