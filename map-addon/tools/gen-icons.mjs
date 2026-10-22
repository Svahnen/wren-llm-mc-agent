#!/usr/bin/env node
// Generates the original mob marker icons (24x24 SVG, drawn from scratch; no Mojang assets).
// Usage: node map-addon/tools/gen-icons.mjs [outDir] [--sheet sheet.svg]
// Writes <outDir>/<type>.svg for every entry plus index.txt ("type category" per line).
// Copyright 2026 Svahnen. Apache-2.0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const sheetIdx = args.indexOf('--sheet');
const sheetOut = sheetIdx >= 0 ? args[sheetIdx + 1] : null;
if (sheetIdx >= 0) args.splice(sheetIdx, 2);
const outDir = args[0] || path.join(here, '..', 'src', 'main', 'resources', 'web', 'icons');

const RING = { hostile: '#e53935', passive: '#43a047', neutral: '#fdd835', npc: '#1e88e5' };

// ---- drawing helpers (coordinates in a 24x24 box; body disc is r=8.2 around 12,12) ----
const c = (x, y, r, f, extra = '') => `<circle cx="${x}" cy="${y}" r="${r}" fill="${f}" ${extra}/>`;
const el = (x, y, rx, ry, f) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${f}"/>`;
const r = (x, y, w, h, f) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>`;
const poly = (pts, f) => `<polygon points="${pts}" fill="${f}"/>`;
const ln = (d, s, w = 1.2) => `<path d="${d}" fill="none" stroke="${s}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const eyes = (col = '#151515', y = 11, dx = 3.3, rad = 1.35) => c(12 - dx, y, rad, col) + c(12 + dx, y, rad, col);
const sq = (col = '#151515', y = 10, dx = 3.3, s = 2.4) => r(12 - dx - s / 2, y, s, s, col) + r(12 + dx - s / 2, y, s, s, col);
const earsP = (f, tip) => poly('4.2,9 5,2.4 10,5.6', f) + poly('19.8,9 19,2.4 14,5.6', f) + (tip ? poly('5,2.4 6.3,4.4 4.6,4.8', tip) + poly('19,2.4 17.7,4.4 19.4,4.8', tip) : '');
const earsR = (f) => c(5.5, 5.5, 2.8, f) + c(18.5, 5.5, 2.8, f);
const earsL = (f, inner) => el(8.3, 3.6, 1.9, 4.2, f) + el(15.7, 3.6, 1.9, 4.2, f) + (inner ? el(8.3, 3.8, 0.8, 2.8, inner) + el(15.7, 3.8, 0.8, 2.8, inner) : '');
const horns = (f) => poly('5.2,8 3.2,3 8,6', f) + poly('18.8,8 20.8,3 16,6', f);
const mouth = (col = '#222', y = 16.3) => ln(`M8.7 ${y}h6.6`, col, 1.3);
const smile = (col = '#222', y = 15.2) => ln(`M8.8 ${y}q3.2 3 6.4 0`, col, 1.2);
const snout = (f, nos, y = 14.6, rx = 3.6, ry = 2.6) => el(12, y, rx, ry, f) + c(10.8, y, 0.65, nos) + c(13.2, y, 0.65, nos);
const brows = (col, y = 8.8) => ln(`M6.4 ${y + 0.8}l4.2 ${-0.9}`, col, 1.5) + ln(`M17.6 ${y + 0.8}l-4.2 ${-0.9}`, col, 1.5);
const fish = (body, belly, tail, eye = '#111', extra = '') =>
  poly('14.6,12 19.2,8.6 19.2,15.4', tail) + el(10.6, 12, 5.8, 4, body) + (belly ? el(10.4, 13.6, 4.6, 1.8, belly) : '') + extra + c(7.2, 11, 0.95, '#fff') + c(7.1, 11, 0.5, eye);

const T = []; // {type, cat, fill, back, front}
const def = (type, cat, fill, front = '', back = '', ring) => T.push({ type, cat, fill, back, front, ring });

// ---- hostile ----
def('zombie', 'hostile', '#5b9a45', sq('#1a2a14', 9.8) + r(7, 15, 10, 1.8, '#2e5a24') + r(5.6, 12.2, 2, 1.4, '#43762f'));
def('husk', 'hostile', '#c4ae7e', sq('#3a2c14', 9.8) + r(7, 15, 10, 1.8, '#7d6a3e') + c(16.5, 13.4, 0.7, '#9b8658') + c(7.6, 6.4, 0.7, '#9b8658'));
def('drowned', 'hostile', '#4aa6a0', sq('#0b3140', 9.8) + r(7, 15, 10, 1.8, '#22666b') + ln('M5.5 6.4q1.6-1.4 3.2 0t3.2 0t3.2 0t3.2 0', '#2d8bb0', 1.1));
def('skeleton', 'hostile', '#e4e4e4', sq('#1c1c1c', 9, 3.2, 3) + poly('11,12.4 13,12.4 12,14', '#777') + ln('M7.6 16.8h8.8M9.6 15.8v2M12 15.8v2M14.4 15.8v2', '#444', 1));
def('stray', 'hostile', '#cfe6f0', sq('#1a2a3c', 9, 3.2, 3) + ln('M7.6 16.8h8.8M10 15.8v2M14 15.8v2', '#456', 1) + '<path d="M4.6 10.5Q12 -2 19.4 10.5Q12 5.5 4.6 10.5Z" fill="#5d8db3"/>');
def('wither_skeleton', 'hostile', '#3a3a3e', sq('#e8e8e8', 9, 3.2, 3) + ln('M7.6 16.8h8.8M10 15.8v2M14 15.8v2', '#9a9a9a', 1));
def('bogged', 'hostile', '#7b8c4c', sq('#16210c', 9.8) + r(7, 15.2, 10, 1.6, '#3b4a22') + c(7.6, 5.2, 1.7, '#c33') + c(12.4, 4.4, 1.5, '#c33') + c(16.4, 5.6, 1.6, '#c33'));
def('creeper', 'hostile', '#5cb85c',
  r(6.2, 7, 3.4, 3.4, '#101a10') + r(14.4, 7, 3.4, 3.4, '#101a10') + r(10.4, 10.8, 3.2, 3.2, '#101a10') + r(8.4, 13.4, 7.2, 4, '#101a10') + r(10.4, 15.6, 3.2, 1.8, '#5cb85c')
  + c(6.4, 15, 0.8, '#3d8a3d') + c(17.4, 6, 0.8, '#3d8a3d'));
def('spider', 'hostile', '#4b3b36', c(9.4, 10.2, 1.7, '#e53935') + c(14.6, 10.2, 1.7, '#e53935') + c(10.2, 7.6, 0.9, '#e53935') + c(13.8, 7.6, 0.9, '#e53935') + ln('M9 14.6l1.4 1.2l1.6-1.2l1.6 1.2l1.4-1.2', '#241a18', 1.2),
  ln('M4 8l-2-3M3.6 11.5H1M3.6 14.5H1M4 17.5l-2 3M20 8l2-3M20.4 11.5H23M20.4 14.5H23M20 17.5l2 3', '#2b211e', 1.3));
def('cave_spider', 'hostile', '#1f6f7c', c(9.6, 10.6, 1.5, '#ff4a3d') + c(14.4, 10.6, 1.5, '#ff4a3d') + c(12, 8, 0.8, '#ff4a3d') + ln('M9.4 14.8l1.4 1l1.2-1l1.2 1l1.4-1', '#0d3a41', 1.1),
  ln('M4 8l-2-3M3.6 11.5H1M3.6 14.5H1M4 17.5l-2 3M20 8l2-3M20.4 11.5H23M20.4 14.5H23M20 17.5l2 3', '#3aa3b3', 1.3));
def('enderman', 'neutral', '#1b1230', r(6.2, 9.8, 4.4, 1.8, '#e27bff') + r(13.4, 9.8, 4.4, 1.8, '#e27bff') + r(9, 15.2, 6, 1, '#4b2c6b') + c(12, 5, 0.7, '#3a2455'));
def('witch', 'hostile', '#6aa04a', eyes('#1a1a1a', 12.2, 3.2, 1.3) + c(12, 14.4, 1.2, '#4c7a30') + ln('M9.6 17.4q2.4 1.4 4.8 0', '#2b2b2b', 1.1),
  poly('12,0.4 4.4,8.8 19.6,8.8', '#5a2a8a') + r(4.6, 8.2, 14.8, 1.6, '#3a1a5a') + r(10.6, 6.2, 2.8, 1.6, '#e0b030'));
def('slime', 'hostile', '#7be05a', r(9.6, 9.8, 5, 5, '#4fb232') + r(8, 11, 2, 2.4, '#1c4a12') + r(14, 11, 2, 2.4, '#1c4a12') + r(11.4, 15.4, 1.6, 1, '#1c4a12') + c(7, 7, 1, '#c8ffb0'));
def('magma_cube', 'hostile', '#5b1f12', r(5.6, 8, 12.8, 1.5, '#ff7a1a') + r(5.6, 13.6, 12.8, 1.5, '#ff7a1a') + r(7.6, 10.4, 2.2, 2, '#ffd23a') + r(14.2, 10.4, 2.2, 2, '#ffd23a') + c(12, 17.4, 0.8, '#ff7a1a'));
def('phantom', 'hostile', '#41518a', eyes('#8bff8b', 11, 3.4, 1.5) + ln('M8.6 15.6l1.2 1.2l1.2-1.2l1.2 1.2l1.2-1.2', '#1b2442', 1.1),
  poly('5,9 0.8,5 1.6,13 5,15', '#2e3a66') + poly('19,9 23.2,5 22.4,13 19,15', '#2e3a66'));
def('pillager', 'hostile', '#928f86', brows('#2f2f2f') + eyes('#1a1a1a', 11.4, 3.2, 1.2) + r(11, 11.6, 2, 4.2, '#7a766d') + mouth('#3a3a3a', 17.4));
def('vindicator', 'hostile', '#8d8a80', brows('#3a1a1a', 8.4) + eyes('#c92a2a', 11.2, 3.2, 1.2) + r(11, 11.6, 2, 3.8, '#76726a') + mouth('#3a3a3a', 17.2) + ln('M6 5.2h12', '#444', 1.6));
def('evoker', 'hostile', '#9a978c', brows('#2f2f2f', 8.6) + eyes('#7be0ff', 11.4, 3.2, 1.2) + r(11, 11.8, 2, 3.8, '#827e74') + r(7, 17.4, 10, 2, '#e8c23a'));
def('ravager', 'hostile', '#5d5148', eyes('#ffd23a', 10.4, 3.4, 1.2) + el(12, 14.6, 4.2, 2.8, '#7c6e62') + c(10.5, 14.6, 0.8, '#222') + c(13.5, 14.6, 0.8, '#222'), horns('#e8dfcf'));
def('zombie_villager', 'hostile', '#5b9a45', sq('#1a2a14', 8.6, 3.2, 2.2) + r(8.6, 6.4, 6.8, 1.2, '#2e3a1e') + r(10.6, 10.6, 2.8, 4.6, '#7a5a3a') + r(7, 17.4, 10, 1.6, '#6b4a2a'));
def('blaze', 'hostile', '#f5c21b', sq('#3a2300', 9.4, 3.2, 2.4) + r(8, 14.6, 8, 1.4, '#e8761a') + r(5.6, 12.4, 2, 1.2, '#e8761a') + r(16.4, 12.4, 2, 1.2, '#e8761a'),
  poly('6,6 5,0.8 8.6,4.2', '#ff9a1a') + poly('12,4.6 12,0 14.4,4.4', '#ff9a1a') + poly('18,6 19,0.8 15.4,4.2', '#ff9a1a'));
def('ghast', 'hostile', '#f1f1f1', ln('M6.4 10.6l3 .6M17.6 10.6l-3 .6', '#8a8a8a', 1.5) + c(12, 15.6, 1.5, '#9a9a9a') + c(7, 13.2, 0.5, '#8cc9ff') + c(17, 13.2, 0.5, '#8cc9ff'));
def('piglin', 'hostile', '#d9917e', snout('#c06b5a', '#5b2218', 14, 3.6, 2.6) + eyes('#222', 10.4, 3.6, 1.1) + poly('9,16.2 9.6,18.4 10.4,16.4', '#fff') + poly('15,16.2 14.4,18.4 13.6,16.4', '#fff'), poly('4,7 1,6 5,12', '#c06b5a') + poly('20,7 23,6 19,12', '#c06b5a'));
def('piglin_brute', 'hostile', '#b87464', snout('#9c5546', '#3a130c', 14, 3.6, 2.6) + eyes('#c62828', 10.4, 3.6, 1.1) + poly('9,16.2 9.6,18.8 10.4,16.4', '#fff') + poly('15,16.2 14.4,18.8 13.6,16.4', '#fff') + ln('M6 5.6h12', '#d4a017', 1.8), poly('4,7 1,6 5,12', '#9c5546') + poly('20,7 23,6 19,12', '#9c5546'));
def('hoglin', 'hostile', '#a0603f', snout('#c9926e', '#2a1408', 14.6, 4.6, 3) + eyes('#111', 10, 3.8, 1.1) + poly('8,15.6 8.6,18.6 9.8,16', '#fff') + poly('16,15.6 15.4,18.6 14.2,16', '#fff'), horns('#eadfc8'));
def('zoglin', 'hostile', '#6e8e58', snout('#8fa878', '#1a2a12', 14.6, 4.6, 3) + eyes('#c62828', 10, 3.8, 1.1) + poly('8,15.6 8.6,18.6 9.8,16', '#fff') + poly('16,15.6 15.4,18.6 14.2,16', '#fff'), horns('#c9c0a8'));
def('guardian', 'hostile', '#5ea89f', c(12, 11.2, 3.4, '#fff') + c(12, 11.2, 1.8, '#f08a1c') + c(12, 11.2, 0.8, '#111') + ln('M7 16.6l1.4-1l1.4 1l1.4-1l1.4 1l1.4-1l1.4 1', '#2c6a64', 1), poly('5,6 3,2 8,4.6', '#3f857c') + poly('19,6 21,2 16,4.6', '#3f857c') + poly('12,4 10.8,0.8 13.2,0.8', '#3f857c'));
def('elder_guardian', 'hostile', '#b9a58c', c(12, 11.2, 3.6, '#fff') + c(12, 11.2, 2, '#e8841c') + c(12, 11.2, 0.9, '#111') + ln('M7 16.6l1.4-1l1.4 1l1.4-1l1.4 1l1.4-1l1.4 1', '#6a5a46', 1), poly('5,6 3,2 8,4.6', '#8a735a') + poly('19,6 21,2 16,4.6', '#8a735a') + poly('12,4 10.8,0.8 13.2,0.8', '#8a735a'));
def('shulker', 'hostile', '#a070b8', r(5.6, 9.4, 12.8, 3, '#e8d4a6') + c(12, 10.9, 1.1, '#111') + r(5.6, 13.6, 12.8, 1.4, '#6e4a82'));
def('silverfish', 'hostile', '#8e8e9a', c(6.4, 12, 2, '#6e6e7a') + c(10, 12, 2.6, '#a0a0ac') + c(14.6, 12, 2.4, '#8e8e9a') + c(18, 12, 1.6, '#6e6e7a') + c(5.8, 11.4, 0.5, '#111'));
def('endermite', 'hostile', '#3f2a58', c(8, 12, 2.4, '#5d3f82') + c(13, 12, 2.8, '#7a52a8') + c(17.4, 12, 1.8, '#5d3f82') + c(7.6, 11.4, 0.6, '#e27bff'));
def('vex', 'hostile', '#9fbbe0', eyes('#b00020', 10.8, 3, 1.1) + ln('M9.6 15.6h4.8', '#2a3a58', 1.2), poly('5,9 0.8,3 1.4,12 5,14', '#cfe3ff') + poly('19,9 23.2,3 22.6,12 19,14', '#cfe3ff'));
def('warden', 'hostile', '#0f4650', r(6, 9.4, 3.4, 2, '#0a1c20') + r(14.6, 9.4, 3.4, 2, '#0a1c20') + r(8, 14, 8, 3, '#2fd6cc') + r(10, 14, 4, 3, '#0a1c20'), poly('6,7 3,2 9,5', '#2fd6cc') + poly('18,7 21,2 15,5', '#2fd6cc'));
def('breeze', 'hostile', '#a9daf2', eyes('#1e4b66', 10.8, 3.2, 1.3) + ln('M6.6 15.4q2.4 2 5.4 0t5.4 0', '#4a8fb5', 1.4) + ln('M8 6.4q4-2 8 0', '#fff', 1.3));
def('wither', 'hostile', '#2b2b2f', sq('#d8d8d8', 9.4, 3.2, 2.6) + ln('M7.8 16.4h8.4M10 15.6v1.8M14 15.6v1.8', '#7a7a80', 1));
def('ender_dragon', 'hostile', '#17101f', eyes('#e27bff', 10.6, 3.4, 1.4) + poly('10,14 12,17.6 14,14', '#e27bff'), poly('5,7 3,1 9,4.6', '#17101f') + poly('19,7 21,1 15,4.6', '#17101f'));

// ---- passive ----
def('pig', 'passive', '#f4a6b6', eyes('#222', 10, 3.6, 1.2) + snout('#e9808f', '#8b3a48', 14.2, 3.8, 2.8), earsP('#ee90a2'));
def('cow', 'passive', '#5b4636', eyes('#111', 10, 3.8, 1.2) + el(12, 15, 4.6, 3, '#e8dfd0') + c(10.4, 15, 0.7, '#7a5a50') + c(13.6, 15, 0.7, '#7a5a50') + r(5.4, 6.4, 3.4, 3, '#f2efe8') + r(15.8, 12.2, 2.8, 2.6, '#f2efe8'), horns('#efe6cf') + el(3.6, 10, 2.2, 1.3, '#7a6050') + el(20.4, 10, 2.2, 1.3, '#7a6050'));
def('mooshroom', 'passive', '#b8242a', eyes('#111', 10, 3.8, 1.2) + el(12, 15, 4.6, 3, '#e8dfd0') + c(10.4, 15, 0.7, '#7a5a50') + c(13.6, 15, 0.7, '#7a5a50') + c(7.2, 7.4, 1.6, '#f6f1e6') + c(16.8, 7.4, 1.2, '#f6f1e6'), horns('#efe6cf'));
def('sheep', 'passive', '#f4f4f0', el(12, 13, 4.2, 4.8, '#b9a58d') + eyes('#222', 11.4, 2, 1) + c(12, 15.6, 0.8, '#8a6f5a'),
  c(5.6, 6.6, 3, '#f4f4f0') + c(12, 4.4, 3.2, '#f4f4f0') + c(18.4, 6.6, 3, '#f4f4f0') + c(3.8, 12, 2.6, '#f4f4f0') + c(20.2, 12, 2.6, '#f4f4f0'));
def('chicken', 'passive', '#fbfbf6', eyes('#111', 10, 3.6, 1.2) + poly('10.2,12.6 13.8,12.6 12,15.8', '#f4a20e') + poly('11,15.4 13,15.4 12,18', '#d62828'), poly('9.6,5.6 10.6,1.6 12,4.4 13.4,1.2 14.6,5.6', '#d62828'));
def('horse', 'passive', '#a56a3a', eyes('#111', 8.6, 3.8, 1.2) + el(12, 15, 4, 4.4, '#c58a5a') + c(10.6, 16.2, 0.7, '#4a2c18') + c(13.4, 16.2, 0.7, '#4a2c18') + r(11, 3.6, 2, 5, '#3f2614'), earsP('#8a5530') + r(10, 1.4, 4, 4, '#3f2614'));
def('donkey', 'passive', '#8f8f98', eyes('#111', 10.4, 3.6, 1.2) + el(12, 15.4, 4, 3.6, '#d6d3cc') + c(10.6, 15.8, 0.7, '#555') + c(13.6, 15.8, 0.7, '#555'), earsL('#8f8f98', '#d6a8b0'));
def('mule', 'passive', '#7d5a42', eyes('#111', 10.4, 3.6, 1.2) + el(12, 15.4, 4, 3.6, '#a98368') + c(10.6, 15.8, 0.7, '#3b2a1e') + c(13.6, 15.8, 0.7, '#3b2a1e'), earsL('#7d5a42', '#c28b8b'));
def('rabbit', 'passive', '#cfa77c', eyes('#2a1a10', 11, 3.4, 1.2) + c(12, 14.2, 1, '#e88aa0') + ln('M12 15.2v1.2M10.4 17q1.6 1 3.2 0', '#6a4a30', 1), earsL('#cfa77c', '#f0b6c0'));
def('wolf', 'neutral', '#c7c7cb', eyes('#222', 10, 3.6, 1.2) + el(12, 15.2, 3.4, 2.8, '#e8e8ea') + c(12, 14, 1.3, '#222') + ln('M12 15v1.4', '#444', 1), earsP('#a9a9ae', '#444'));
def('cat', 'passive', '#e8a23c', eyes('#2e7d32', 10.6, 3.4, 1.3) + poly('11,13 13,13 12,14.4', '#e9858f') + ln('M3.2 13.4l5 .8M3.4 16l4.8-.8M20.8 13.4l-5 .8M20.6 16l-4.8-.8', '#fff', 0.9) + ln('M8.5 6.4l.6 2M15.5 6.4l-.6 2M12 5.4v2.2', '#a86414', 1), earsP('#e8a23c', '#f0b6b6'));
def('ocelot', 'passive', '#e6c764', eyes('#3b7d2e', 10.6, 3.4, 1.3) + poly('11,13 13,13 12,14.4', '#d77') + c(7.4, 7.4, 0.8, '#6a4a14') + c(16.6, 7.4, 0.8, '#6a4a14') + c(9.4, 16.4, 0.8, '#6a4a14') + c(14.6, 16.4, 0.8, '#6a4a14'), earsP('#e6c764', '#6a4a14'));
def('fox', 'passive', '#ea7a2b', eyes('#222', 10, 3.4, 1.2) + poly('4.8,13 12,19.6 19.2,13 12,15.6', '#fbf5ec') + c(12, 16.6, 1, '#111'), earsP('#ea7a2b', '#2a1810'));
def('salmon', 'passive', '#9fd4ea', fish('#cf6a58', '#f2a49a', '#b24a3a'));
def('cod', 'passive', '#9fd4ea', fish('#b79a74', '#e0cfae', '#8d7550'));
def('tropical_fish', 'passive', '#9fd4ea', fish('#ff9f1c', null, '#2fa6d9', '#111', r(9.2, 8.4, 1.8, 7.2, '#fff') + r(12.2, 8.6, 1.4, 6.8, '#2fa6d9')));
def('pufferfish', 'passive', '#e9d04e', eyes('#111', 10.2, 3.2, 1.3) + c(12, 15.8, 1.3, '#a8801a') + c(12 - 3.2, 10.2, 0.5, '#fff') + c(12 + 3.2, 10.2, 0.5, '#fff'), poly('12,0.8 10.6,4 13.4,4', '#c9a030') + poly('3,12 6,10.6 6,13.4', '#c9a030') + poly('21,12 18,10.6 18,13.4', '#c9a030') + poly('12,23.2 10.6,20 13.4,20', '#c9a030'));
def('squid', 'passive', '#2e4f84', eyes('#e6f0ff', 10.4, 3.4, 1.6) + c(8.6, 10.6, 0.6, '#111') + c(15.4, 10.6, 0.6, '#111'), ln('M7 17v4.4M10 18v4.4M14 18v4.4M17 17v4.4', '#2e4f84', 1.8));
def('glow_squid', 'passive', '#27b4ad', eyes('#e8fffb', 10.4, 3.4, 1.6) + c(8.6, 10.6, 0.6, '#0a4a46') + c(15.4, 10.6, 0.6, '#0a4a46'), ln('M7 17v4.4M10 18v4.4M14 18v4.4M17 17v4.4', '#27b4ad', 1.8));
def('bee', 'neutral', '#f7c928', r(5, 8.6, 14, 2, '#2a2210') + r(5, 13.8, 14, 2, '#2a2210') + eyes('#111', 12, 3.8, 1.1) + c(12, 18.4, 1, '#2a2210'), el(5.6, 4.6, 3.4, 2, 'rgba(255,255,255,.85)') + el(18.4, 4.6, 3.4, 2, 'rgba(255,255,255,.85)'));
def('llama', 'neutral', '#e5d3ab', eyes('#222', 10.6, 3.4, 1.2) + el(12, 15.4, 3.6, 3, '#f2e6c8') + c(10.8, 15.4, 0.6, '#555') + c(13.2, 15.4, 0.6, '#555') + ln('M8 7.2q4-2.4 8 0', '#c14d4d', 1.8), earsL('#e5d3ab', '#c9a98a'));
def('trader_llama', 'neutral', '#e5d3ab', eyes('#222', 10.6, 3.4, 1.2) + el(12, 15.4, 3.6, 3, '#f2e6c8') + c(10.8, 15.4, 0.6, '#555') + c(13.2, 15.4, 0.6, '#555') + ln('M8 7.2q4-2.4 8 0', '#2a5db0', 1.8), earsL('#e5d3ab', '#c9a98a'));
def('goat', 'neutral', '#efeeea', eyes('#222', 10.4, 3.6, 1.3) + el(12, 15.2, 3.4, 2.8, '#d9d6cf') + c(10.8, 15.2, 0.6, '#555') + c(13.2, 15.2, 0.6, '#555') + poly('11,17.4 13,17.4 12,20', '#efeeea'), ln('M7 6.6q-4-1-2.6-5M17 6.6q4-1 2.6-5', '#a9a79f', 2.2) + el(3.6, 9.4, 2, 1.1, '#d9d6cf') + el(20.4, 9.4, 2, 1.1, '#d9d6cf'));
def('villager', 'npc', '#d3a982', c(8.7, 10.8, 1.3, '#fff') + c(15.3, 10.8, 1.3, '#fff') + c(8.9, 10.8, 0.8, '#2e8b3e') + c(15.1, 10.8, 0.8, '#2e8b3e') + r(6.6, 8.2, 10.8, 1.6, '#4a2f1c') + el(12, 14.6, 1.8, 3.4, '#b3835a') + r(5.6, 18.4, 12.8, 1.4, '#7a5230'));
def('wandering_trader', 'npc', '#d3a982', c(8.7, 11.2, 1.2, '#fff') + c(15.3, 11.2, 1.2, '#fff') + c(8.9, 11.2, 0.7, '#222') + c(15.1, 11.2, 0.7, '#222') + r(6.6, 8.6, 10.8, 1.4, '#e6dccb') + el(12, 14.8, 1.8, 3.2, '#b3835a') + ln('M8 18q4 2.6 8 0', '#e6dccb', 1.6),
  '<path d="M3.4 14Q3.4 1 12 1Q20.6 1 20.6 14L20.6 18L3.4 18Z" fill="#2a5db0"/>');
def('iron_golem', 'neutral', '#b5b8ad', r(5.6, 8.2, 4.2, 1.4, '#555') + r(14.2, 8.2, 4.2, 1.4, '#555') + r(6.8, 10, 2.8, 1.6, '#e8d070') + r(14.4, 10, 2.8, 1.6, '#e8d070') + r(10.6, 11, 2.8, 5.6, '#a37a62') + ln('M6 5.6l2.4 3.4M18 14.8l-2.6 3', '#3f8a3f', 1.4) + ln('M8 18.6h8', '#777', 1));
def('snow_golem', 'passive', '#f6f8fa', r(6.4, 4.6, 11.2, 7.2, '#e8902a') + r(8, 6.6, 2, 2, '#1a1a1a') + r(14, 6.6, 2, 2, '#1a1a1a') + r(9, 9.6, 6, 1.2, '#1a1a1a') + c(12, 15.2, 0.9, '#2a2a2a') + c(12, 18, 0.9, '#2a2a2a'));
def('bat', 'passive', '#5a463c', eyes('#f0d0a0', 11, 2.6, 1) + poly('11,14 13,14 12,16', '#fff'), poly('6,9 0.6,6 2.4,13 4.2,11 6,14', '#3d2e27') + poly('18,9 23.4,6 21.6,13 19.8,11 18,14', '#3d2e27') + poly('8,6 8.6,2 10.6,5', '#5a463c') + poly('16,6 15.4,2 13.4,5', '#5a463c'));
def('parrot', 'passive', '#d8312b', eyes('#111', 10, 3.2, 1.2) + poly('10,12.4 14,12.4 12,17', '#f4f0e6') + r(5.6, 14.4, 2, 2, '#1e88e5'), poly('10,5 12,0.8 14,5', '#2bb04a'));
def('axolotl', 'passive', '#f4b6c8', eyes('#222', 11, 3.2, 1) + smile('#b04a6a', 14.6), ln('M3 7l-2-1.6M3.4 9.6H0.8M3 12l-2 1.6M21 7l2-1.6M20.6 9.6h2.6M21 12l2 1.6', '#e8628a', 1.8));
def('turtle', 'passive', '#5fa84a', eyes('#111', 14.8, 3.2, 1.1) + ln('M7 6.2h10M9 3.8v5M15 3.8v5', '#2d6a2a', 1.2) + smile('#2d6a2a', 17.6), el(12, 6.4, 6.6, 4.4, '#3f8a38') + ln('M7 6.2h10M12 2.4v8', '#2d6a2a', 1));
def('dolphin', 'passive', '#8da3b8', eyes('#111', 10.4, 3.6, 1.1) + el(12, 15.6, 3, 2, '#dce4ec') + ln('M9.6 16.4q2.4 1.4 4.8 0', '#4a5a6a', 1), poly('10,6 12,1 14,6', '#6f8398'));
def('polar_bear', 'neutral', '#f5f7f8', eyes('#111', 10.4, 3.4, 1.2) + el(12, 15, 3.2, 2.6, '#dfe6ea') + c(12, 14, 1.2, '#111'), earsR('#f5f7f8'));
def('panda', 'neutral', '#f4f4f2', el(8.4, 10.8, 2, 2.6, '#1a1a1a') + el(15.6, 10.8, 2, 2.6, '#1a1a1a') + c(8.4, 10.6, 0.7, '#fff') + c(15.6, 10.6, 0.7, '#fff') + el(12, 15.2, 2.6, 2, '#e4e4e0') + c(12, 14.4, 1, '#1a1a1a'), earsR('#1a1a1a'));
def('frog', 'passive', '#5fa05a', ln('M7 16.4q5 2.6 10 0', '#2d5a2a', 1.4) + c(12, 12.4, 0.5, '#2d5a2a'), c(7.6, 5.2, 3, '#5fa05a') + c(16.4, 5.2, 3, '#5fa05a') + c(7.6, 5.2, 1.4, '#fff') + c(16.4, 5.2, 1.4, '#fff') + c(7.6, 5.2, 0.7, '#111') + c(16.4, 5.2, 0.7, '#111'));
def('camel', 'passive', '#cfa569', eyes('#222', 10.6, 3.4, 1.2) + el(12, 15.4, 3.8, 3, '#e3c28a') + c(10.8, 15.6, 0.6, '#555') + c(13.2, 15.6, 0.6, '#555'), earsR('#cfa569') + el(12, 3, 3.2, 2.8, '#b88a50'));
def('allay', 'passive', '#59c0f0', eyes('#0a3c5a', 11, 3, 1.2) + smile('#0a3c5a', 14.8), poly('5,10 0.6,5 1.6,13 5,15', '#a8e4ff') + poly('19,10 23.4,5 22.4,13 19,15', '#a8e4ff'));
def('strider', 'passive', '#a23a3a', eyes('#222', 10.4, 3.2, 1.2) + ln('M6 15.4q6 3 12 0', '#5a1818', 1.3), ln('M6 3.6v3.4M9 2v4M12 1.4v4.4M15 2v4M18 3.6v3.4', '#f0a050', 1.8));
def('armadillo', 'passive', '#a98a74', eyes('#222', 14, 3.4, 1.1) + ln('M6 6.6h12M7 9.2h10', '#6a5444', 1.2) + c(12, 16.4, 1, '#d6a8a0'), el(12, 7, 6.6, 3.6, '#85685a'));
def('sniffer', 'passive', '#a23a30', eyes('#fff', 9.4, 3.8, 1.4) + c(8.2, 9.4, 0.7, '#111') + c(15.8, 9.4, 0.7, '#111') + el(12, 15.6, 5, 2.6, '#d96a52') + c(10, 15.6, 0.7, '#6a1a14') + c(14, 15.6, 0.7, '#6a1a14'), c(4.8, 5.4, 2.6, '#3f8a38') + c(19.2, 5.4, 2.6, '#3f8a38'));

// ---- fallbacks (one per category) ----
const glyph = (col) => eyes(col, 10.4, 3.2, 1.3) + mouth(col, 16);
def('fallback-hostile', 'hostile', '#9c4a44', sq('#1a0a0a', 9.4) + brows('#1a0a0a', 7.6) + ln('M8 16.6l2-1.6l2 1.6l2-1.6l2 1.6', '#1a0a0a', 1.2));
def('fallback-passive', 'passive', '#8fcf8a', glyph('#14301a') + ln('M6 6.4q1-2.4 3.4-1.2M18 6.4q-1-2.4-3.4-1.2', '#14301a', 1.2));
def('fallback-neutral', 'neutral', '#e6d58a', glyph('#3a3010') + ln('M7 7.6h3.6M13.4 7.6H17', '#3a3010', 1.4));
def('fallback-npc', 'npc', '#c9a888', glyph('#2a2010') + el(12, 13.4, 1.4, 2.6, '#a8805c') + r(5.6, 18.4, 12.8, 1.4, '#6a4a2a'));

// ---- output ----
function svg(t) {
  const ring = RING[t.cat];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">`
    + `<title>${t.type.replace(/_/g, ' ')}</title>`
    + c(12, 12, 11.7, '#ffffff', 'fill-opacity="0.92"')
    + t.back
    + c(12, 12, 10.6, ring)
    + `<clipPath id="b"><circle cx="12" cy="12" r="8.2"/></clipPath>`
    + c(12, 12, 8.2, t.fill)
    + `<g clip-path="url(#b)">${t.front}</g>`
    + `</svg>\n`;
}

fs.mkdirSync(outDir, { recursive: true });
const index = [];
for (const t of T) {
  fs.writeFileSync(path.join(outDir, `${t.type}.svg`), svg(t));
  index.push(`${t.type} ${t.cat}`);
}
fs.writeFileSync(path.join(outDir, 'index.txt'), index.join('\n') + '\n');
console.log(`wrote ${T.length} icons to ${outDir}`);

if (sheetOut) {
  const cols = 10, cell = 84, scale = 3;
  const rows = Math.ceil(T.length / cols);
  const W = cols * cell + 8, H = rows * cell + 8;
  let body = `<rect width="${W}" height="${H}" fill="#2b3a2e"/>`;
  T.forEach((t, i) => {
    const x = 4 + (i % cols) * cell, y = 4 + Math.floor(i / cols) * cell;
    const inner = svg(t).replace(/<svg[^>]*>/, '').replace('</svg>', '').replace(/id="b"/, `id="b${i}"`).replace('url(#b)', `url(#b${i})`);
    body += `<g transform="translate(${x + (cell - 24 * scale) / 2},${y + 2}) scale(${scale})">${inner}</g>`
      + `<text x="${x + cell / 2}" y="${y + cell - 6}" font-family="DejaVu Sans, sans-serif" font-size="9" text-anchor="middle" fill="#ffffff">${t.type.replace('fallback-', 'fb-').replace(/_/g, ' ')}</text>`;
  });
  fs.writeFileSync(sheetOut, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>\n`);
}
