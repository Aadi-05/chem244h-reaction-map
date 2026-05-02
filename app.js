const NODE_W = 210;
const NODE_H = 150;
const UNIT = 92;
const PAD = 700;
const state = {
  ontology: null,
  nodes: [],
  edges: [],
  groups: [],
  nodeById: new Map(),
  segments: [],
  selectedChapters: new Set(),
  selectedFunctional: 'all',
  selectedType: 'all',
  activeReaction: null,
  activeNode: null,
  rdkit: null
};

const svg = d3.select('#reactionMap');
const root = svg.append('g').attr('class', 'root');
const clusters = root.append('g');
const edgeLayer = root.append('g');
const nodeLayer = root.append('g');
const defs = svg.append('defs');
const hover = document.querySelector('#hoverLabel');
const zoom = d3.zoom().scaleExtent([0.06, 2.9]).on('zoom', (event) => {
  root.attr('transform', event.transform);
  svg.classed('zoom-labels', event.transform.k > 0.72);
});
svg.call(zoom);

init();

async function init() {
  const [ontologyText, edgeText] = await Promise.all([
    loadText('ontology', 'orgo2_reaction_ontology.json'),
    loadText('edges', 'orgo2_reactions_edges.jsonl')
  ]);
  state.ontology = JSON.parse(ontologyText);
  state.edges = edgeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(JSON.parse);
  state.nodes = state.ontology.nodes.map((node) => ({ ...node }));
  state.groups = state.ontology.groups || [];
  state.nodeById = new Map(state.nodes.map((node) => [node.id, node]));
  positionNodes();
  state.selectedChapters = new Set(unique(state.edges.map((edge) => String(edge.chapter))));
  state.segments = buildSegments();
  await initRDKit();
  buildControls();
  draw();
  renderStructures();
  bindControls();
  applyFilters();
  fitMap(false);
}

async function loadText(key, url) {
  if (window.ORG2_DATA?.[key]) return inflate(window.ORG2_DATA[key]);
  return fetch(url).then((response) => response.text());
}

async function inflate(base64) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function initRDKit() {
  if (typeof initRDKitModule !== 'function') return;
  try { state.rdkit = await initRDKitModule(); } catch {}
}

function positionNodes() {
  const minX = Math.min(...state.nodes.map((node) => node.suggested_position.x));
  const maxY = Math.max(...state.nodes.map((node) => node.suggested_position.y));
  state.nodes.forEach((node) => {
    node.x = (node.suggested_position.x - minX) * UNIT + PAD;
    node.y = (maxY - node.suggested_position.y) * UNIT + PAD;
    node.cx = node.x + NODE_W / 2;
    node.cy = node.y + NODE_H / 2;
  });
}

function buildSegments() {
  const segments = [];
  state.edges.forEach((edge) => {
    (edge.source_node_ids || []).forEach((sourceId) => {
      (edge.target_node_ids || []).forEach((targetId) => {
        if (state.nodeById.has(sourceId) && state.nodeById.has(targetId)) {
          segments.push({ id: `${edge.id}-${segments.length}`, reactionId: edge.id, sourceId, targetId, edge });
        }
      });
    });
  });
  const counts = new Map();
  segments.forEach((segment) => {
    const key = `${segment.sourceId}->${segment.targetId}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const seen = new Map();
  segments.forEach((segment) => {
    const key = `${segment.sourceId}->${segment.targetId}`;
    const index = seen.get(key) || 0;
    seen.set(key, index + 1);
    segment.parallelIndex = index - (counts.get(key) - 1) / 2;
  });
  return segments;
}

function buildControls() {
  document.querySelector('#dataNote').textContent = "Aadithiya Bharanidharan | ab2838@njit | NJIT '28";
  const colors = state.ontology.metadata.chapter_colors;
  const chapters = unique(state.edges.map((edge) => String(edge.chapter))).sort((a, b) => Number(a) - Number(b));
  const chapterWrap = document.querySelector('#chapterFilters');
  chapterWrap.innerHTML = '';
  chapters.forEach((chapter) => {
    const label = document.createElement('label');
    label.className = 'chapter-chip';
    label.style.setProperty('--chip-color', colors[chapter] || '#777');
    label.innerHTML = `<input type="checkbox" value="${esc(chapter)}" checked><span class="swatch"></span><span>Ch ${esc(chapter)}</span>`;
    label.querySelector('input').addEventListener('change', (event) => {
      event.target.checked ? state.selectedChapters.add(chapter) : state.selectedChapters.delete(chapter);
      applyFilters();
    });
    chapterWrap.append(label);
  });

  const functional = document.querySelector('#functionalFilter');
  functional.innerHTML = '<option value="all">All functional groups</option>';
  state.groups.forEach((group) => {
    functional.add(new Option(group.label, `group:${group.id}`));
    state.nodes.filter((node) => node.group === group.id).sort((a, b) => a.label.localeCompare(b.label)).forEach((node) => {
      functional.add(new Option(`  ${node.label}`, `node:${node.id}`));
    });
  });

  const type = document.querySelector('#typeFilter');
  type.innerHTML = '<option value="all">All reaction types</option>';
  unique(state.edges.flatMap((edge) => edge.tags || [])).sort().forEach((tag) => type.add(new Option(tag, tag)));

  const titleByChapter = new Map(state.edges.map((edge) => [String(edge.chapter), edge.chapter_title || `Chapter ${edge.chapter}`]));
  document.querySelector('#legend').innerHTML = chapters.map((chapter) => `<div class="legend-item"><span class="legend-swatch" style="--chip-color:${colors[chapter] || '#777'}"></span><strong>${esc(chapter)}</strong><span>${esc(titleByChapter.get(chapter))}</span></div>`).join('');
}

function draw() {
  drawMarkers();
  drawClusters();
  drawEdges();
  drawNodes();
}

function drawMarkers() {
  Object.entries(state.ontology.metadata.chapter_colors).forEach(([chapter, color]) => {
    defs.append('marker').attr('id', `arrow-${chapter}`).attr('viewBox', '0 -5 10 10').attr('refX', 8.7).attr('refY', 0).attr('markerWidth', 5.5).attr('markerHeight', 5.5).attr('orient', 'auto').attr('markerUnits', 'strokeWidth').append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', color).attr('opacity', 0.78);
  });
}

function drawClusters() {
  const boxes = state.groups.map((group) => {
    const nodes = state.nodes.filter((node) => node.group === group.id);
    const minX = Math.min(...nodes.map((node) => node.x)) - 72;
    const maxX = Math.max(...nodes.map((node) => node.x + NODE_W)) + 72;
    const minY = Math.min(...nodes.map((node) => node.y)) - 86;
    const maxY = Math.max(...nodes.map((node) => node.y + NODE_H)) + 78;
    return { ...group, x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  });
  const group = clusters.selectAll('.cluster').data(boxes).join('g').attr('class', 'cluster');
  group.append('rect').attr('class', 'cluster-bg').attr('x', (box) => box.x).attr('y', (box) => box.y).attr('width', (box) => box.width).attr('height', (box) => box.height).attr('rx', 18).style('--cluster-fill', (box) => box.suggested_background || '#f3f4f1');
  group.append('text').attr('class', 'cluster-label').attr('x', (box) => box.x + 26).attr('y', (box) => box.y + 38).text((box) => box.label);
}

function drawEdges() {
  const edge = edgeLayer.selectAll('.edge').data(state.segments, (segment) => segment.id).join('g').attr('class', 'edge').style('--edge-color', edgeColor);
  edge.append('path').attr('class', 'edge-path').attr('d', pathFor).attr('marker-end', (segment) => `url(#arrow-${segment.edge.chapter})`);
  edge.append('path').attr('class', 'edge-hit').attr('d', pathFor).on('mouseenter', showHover).on('mousemove', moveHover).on('mouseleave', clearHover).on('click', (event, segment) => { event.stopPropagation(); focusReaction(segment.reactionId); });
  edge.append('text').attr('class', 'edge-label').attr('x', (segment) => labelPoint(segment).x).attr('y', (segment) => labelPoint(segment).y).text((segment) => segment.edge.display?.edge_label || segment.edge.name);
}

function drawNodes() {
  const node = nodeLayer.selectAll('.node-shell').data(state.nodes, (item) => item.id).join('g').attr('class', 'node-shell').attr('data-node-id', (item) => item.id).attr('transform', (item) => `translate(${item.x},${item.y})`);
  node.append('rect').attr('class', 'node-rect').attr('width', NODE_W).attr('height', NODE_H).attr('rx', 8);
  node.append('foreignObject').attr('width', NODE_W).attr('height', NODE_H).append('xhtml:div').attr('class', 'node-card').html((node) => `<div class="structure-slot">${fallback(node)}</div><div class="node-name" title="${esc(node.label)}">${esc(node.label)}</div><div class="node-formula" title="${esc(node.formula_pattern || '')}">${esc(node.formula_pattern || '')}</div>`);
}

function renderStructures() {
  document.querySelectorAll('.node-shell').forEach((shell) => {
    const node = state.nodeById.get(shell.dataset.nodeId);
    const slot = shell.querySelector('.structure-slot');
    slot.innerHTML = molSvg(node) || fallback(node);
  });
}

function molSvg(node) {
  if (!state.rdkit || !node.representative_smiles) return '';
  let mol;
  try {
    mol = state.rdkit.get_mol(node.representative_smiles);
    return mol?.get_svg_with_highlights(JSON.stringify({ width: 190, height: 82, bondLineWidth: 1.65, baseFontSize: 0.74, padding: 0.04 })) || '';
  } catch { return ''; }
  finally { if (mol) mol.delete(); }
}

function fallback(node) {
  return `<div class="structure-fallback">${esc(node.representative_smiles || node.formula_pattern || node.label)}</div>`;
}

function bindControls() {
  document.querySelector('#functionalFilter').addEventListener('change', (event) => { state.selectedFunctional = event.target.value; applyFilters(); });
  document.querySelector('#typeFilter').addEventListener('change', (event) => { state.selectedType = event.target.value; applyFilters(); });
  document.querySelector('#clearFilters').addEventListener('click', clearFilters);
  document.querySelector('#searchInput').addEventListener('input', updateReactionSearch);
  document.querySelector('#clearSearch').addEventListener('click', () => { document.querySelector('#searchInput').value = ''; document.querySelector('#searchResults').innerHTML = ''; });
  document.querySelector('#openCanvasSearch').addEventListener('click', toggleFunctionalSearch);
  document.querySelector('#canvasFunctionalSearch').addEventListener('input', updateFunctionalSearch);
  document.querySelector('#homeView').addEventListener('click', () => fitMap(true));
  document.querySelector('#closePanel').addEventListener('click', clearSelection);
  window.addEventListener('resize', () => fitMap(false));
}

function applyFilters() {
  const visibleNodes = new Set();
  const visibleReactions = new Set();
  state.segments.forEach((segment) => {
    const show = matchesFilters(segment);
    if (show) { visibleNodes.add(segment.sourceId); visibleNodes.add(segment.targetId); visibleReactions.add(segment.reactionId); }
    segment.visible = show;
  });
  edgeLayer.selectAll('.edge').classed('is-filtered', (segment) => !segment.visible);
  nodeLayer.selectAll('.node-shell').classed('is-dim', (node) => visibleNodes.size && !visibleNodes.has(node.id)).classed('is-highlight', (node) => isNodeActive(node.id));
  document.querySelector('#visibleCount').textContent = `${visibleReactions.size} reactions visible`;
}

function matchesFilters(segment) {
  const edge = segment.edge;
  if (!state.selectedChapters.has(String(edge.chapter))) return false;
  if (state.selectedType !== 'all' && !(edge.tags || []).includes(state.selectedType)) return false;
  if (state.selectedFunctional.startsWith('group:')) {
    const groupId = state.selectedFunctional.slice(6);
    return state.nodeById.get(segment.sourceId)?.group === groupId || state.nodeById.get(segment.targetId)?.group === groupId;
  }
  if (state.selectedFunctional.startsWith('node:')) {
    const nodeId = state.selectedFunctional.slice(5);
    return segment.sourceId === nodeId || segment.targetId === nodeId;
  }
  return true;
}

function showHover(event, segment) {
  edgeLayer.selectAll('.edge').classed('is-active', (item) => item.reactionId === segment.reactionId);
  nodeLayer.selectAll('.node-shell').classed('is-highlight', (node) => node.id === segment.sourceId || node.id === segment.targetId || isNodeActive(node.id));
  hover.hidden = false;
  hover.innerHTML = `<strong>${esc(segment.edge.display?.edge_label || segment.edge.name)}</strong><br>${esc(segment.edge.reagents_conditions || 'No reagent conditions listed')}`;
  moveHover(event);
}

function moveHover(event) {
  const rect = document.querySelector('.map-stage').getBoundingClientRect();
  hover.style.left = `${event.clientX - rect.left + 14}px`;
  hover.style.top = `${event.clientY - rect.top + 14}px`;
}

function clearHover() {
  hover.hidden = true;
  syncActive();
}

function focusReaction(id) {
  state.activeNode = null;
  state.activeReaction = id;
  syncActive();
  const edge = state.edges.find((item) => item.id === id);
  if (edge) showDetails(edge);
  zoomToReaction(id);
}

function syncActive() {
  edgeLayer.selectAll('.edge').classed('is-active', (segment) => segment.reactionId === state.activeReaction);
  nodeLayer.selectAll('.node-shell').classed('is-highlight', (node) => isNodeActive(node.id));
}

function isNodeActive(id) {
  if (state.activeNode === id) return true;
  if (!state.activeReaction) return false;
  return state.segments.filter((segment) => segment.reactionId === state.activeReaction).some((segment) => segment.sourceId === id || segment.targetId === id);
}

function showDetails(edge) {
  const panel = document.querySelector('#detailPanel');
  const source = (edge.source_node_ids || []).map((id) => state.nodeById.get(id)?.label || id).join(', ');
  const target = (edge.target_node_ids || []).map((id) => state.nodeById.get(id)?.label || id).join(', ');
  panel.innerHTML = `<button id="closePanel" class="icon-button close-button" type="button" aria-label="Close details">x</button><p class="eyebrow">Chapter ${esc(edge.chapter)}${edge.reaction_ref ? ` | ${esc(edge.reaction_ref)}` : ''}</p><h2>${esc(edge.name)}</h2><p class="meta-line">${esc(edge.chapter_title || '')}</p><div class="pill-row">${(edge.tags || []).map((tag) => `<span class="pill">${esc(tag)}</span>`).join('')}</div>${detail('Transformation', `${source || edge.reactant_functional_group || 'Starting group'} -> ${target || edge.product_functional_group || 'Product group'}`)}${detail('Reagents and Conditions', edge.reagents_conditions || 'No reagent conditions listed')}${list('Multistep Conditions', edge.steps)}${detail('Mechanism Summary', edge.mechanism_summary)}${list('Stereochemistry / Regiochemistry / Caveats', edge.key_caveats)}${list('Synthetic Intermediates', edge.synthetic_intermediates)}`;
  panel.querySelector('#closePanel').addEventListener('click', clearSelection);
}

function detail(title, text) {
  return text ? `<div class="detail-section"><h3>${esc(title)}</h3><div class="detail-card">${esc(text)}</div></div>` : '';
}

function list(title, items) {
  return items?.length ? `<div class="detail-section"><h3>${esc(title)}</h3><ul class="detail-list">${items.map((item) => `<li>${esc(String(item))}</li>`).join('')}</ul></div>` : '';
}

function clearSelection() {
  state.activeReaction = null;
  state.activeNode = null;
  syncActive();
  document.querySelector('#detailPanel').innerHTML = '<button id="closePanel" class="icon-button close-button" type="button" aria-label="Close details">x</button><p class="eyebrow">Select a reaction</p><h2>Reaction details</h2><p class="empty-panel">Hover over arrows for quick labels. Click an arrow or search result to inspect the full mechanism.</p>';
  document.querySelector('#closePanel').addEventListener('click', clearSelection);
}

function updateReactionSearch() {
  const query = document.querySelector('#searchInput').value.trim().toLowerCase();
  const box = document.querySelector('#searchResults');
  box.innerHTML = '';
  if (!query) return;
  const matches = state.edges.map((edge) => ({ edge, score: reactionScore(edge, query) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.edge.name.localeCompare(b.edge.name)).slice(0, 14);
  if (!matches.length) { box.innerHTML = '<div class="meta-line">No matching reactions in the ontology.</div>'; return; }
  matches.forEach(({ edge }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'result-button';
    button.innerHTML = `<strong>${esc(edge.name)}</strong><span>Ch ${esc(edge.chapter)} | ${esc(edge.reagents_conditions || edge.reactant_functional_group || '')}</span>`;
    button.addEventListener('click', () => focusReaction(edge.id));
    box.append(button);
  });
}

function reactionScore(edge, query) {
  const nodes = [...(edge.source_node_ids || []), ...(edge.target_node_ids || [])].map((id) => state.nodeById.get(id)?.label || id).join(' ');
  const text = [edge.name, edge.reaction_ref, `chapter ${edge.chapter}`, edge.chapter_title, edge.reactant_functional_group, edge.product_functional_group, edge.reagents_conditions, edge.mechanism_summary, ...(edge.steps || []), ...(edge.key_caveats || []), ...(edge.tags || []), nodes].filter(Boolean).join(' ').toLowerCase();
  if (!text.includes(query)) return 0;
  return 1 + ((edge.name || '').toLowerCase().includes(query) ? 6 : 0) + ((edge.reagents_conditions || '').toLowerCase().includes(query) ? 4 : 0) + ((edge.tags || []).join(' ').toLowerCase().includes(query) ? 3 : 0);
}

function toggleFunctionalSearch() {
  const panel = document.querySelector('#canvasSearchPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) { document.querySelector('#canvasFunctionalSearch').focus(); updateFunctionalSearch(); }
}

function updateFunctionalSearch() {
  const query = document.querySelector('#canvasFunctionalSearch').value.trim().toLowerCase();
  const box = document.querySelector('#canvasFunctionalResults');
  box.innerHTML = '';
  const matches = functionalMatches(query);
  if (!matches.length) { box.innerHTML = `<div class="meta-line">${query ? 'No functional groups found.' : 'Type to search nodes or families.'}</div>`; return; }
  matches.forEach((match) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'canvas-result-button';
    button.innerHTML = `<strong>${esc(match.label)}</strong><span>${esc(match.subtitle)}</span>`;
    button.addEventListener('click', () => {
      document.querySelector('#canvasSearchPanel').hidden = true;
      document.querySelector('#canvasFunctionalSearch').value = '';
      box.innerHTML = '';
      match.kind === 'group' ? zoomToGroup(match.id) : focusNode(match.id);
    });
    box.append(button);
  });
}

function functionalMatches(query) {
  const all = [
    ...state.groups.map((group) => ({ kind: 'group', id: group.id, label: group.label, subtitle: 'Functional-group family', haystack: `${group.id} ${group.label}`.toLowerCase() })),
    ...state.nodes.map((node) => ({ kind: 'node', id: node.id, label: node.label, subtitle: `${node.formula_pattern || ''} | ${node.group_label || ''}`, haystack: `${node.id} ${node.label} ${node.formula_pattern || ''} ${node.group_label || ''} ${node.representative_smiles || ''}`.toLowerCase() }))
  ];
  if (!query) return all.slice(0, 10);
  return all.map((item) => ({ ...item, score: item.haystack.includes(query) ? 1 + (item.label.toLowerCase().startsWith(query) ? 5 : 0) + (item.kind === 'node' ? 2 : 0) : 0 })).filter((item) => item.score).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, 12);
}

function focusNode(id) {
  clearSelection();
  state.activeNode = id;
  syncActive();
  zoomToNode(id);
}

function clearFilters() {
  document.querySelectorAll('#chapterFilters input').forEach((input) => { input.checked = true; state.selectedChapters.add(input.value); });
  document.querySelector('#functionalFilter').value = 'all';
  document.querySelector('#typeFilter').value = 'all';
  state.selectedFunctional = 'all';
  state.selectedType = 'all';
  applyFilters();
}

function pathFor(segment) {
  const source = state.nodeById.get(segment.sourceId);
  const target = state.nodeById.get(segment.targetId);
  if (segment.sourceId === segment.targetId) return loopPath(source, segment);
  const start = border(source, target);
  const end = border(target, source);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy) || 1;
  const normal = { x: -dy / dist, y: dx / dist };
  const offset = Math.min(230, Math.max(52, dist * 0.12)) * (Number(segment.edge.chapter) % 2 === 0 ? 1 : -1) + segment.parallelIndex * 34;
  const mid = { x: (start.x + end.x) / 2 + normal.x * offset, y: (start.y + end.y) / 2 + normal.y * offset };
  return `M${start.x},${start.y} Q${mid.x},${mid.y} ${end.x},${end.y}`;
}

function loopPath(node, segment) {
  const spread = 52 + Math.abs(segment.parallelIndex) * 18;
  const side = segment.parallelIndex >= 0 ? 1 : -1;
  return `M${node.cx + NODE_W / 2 - 22},${node.cy - NODE_H / 2 + 20} C${node.cx + NODE_W / 2 + spread * 1.7},${node.cy - NODE_H / 2 - spread * side} ${node.cx + NODE_W / 2 + spread * 1.7},${node.cy + NODE_H / 2 + spread * side} ${node.cx + NODE_W / 2 - 8},${node.cy + NODE_H / 2 - 24}`;
}

function labelPoint(segment) {
  const source = state.nodeById.get(segment.sourceId);
  const target = state.nodeById.get(segment.targetId);
  if (segment.sourceId === segment.targetId) return { x: source.cx + NODE_W / 2 + 70, y: source.cy + segment.parallelIndex * 22 };
  const start = border(source, target);
  const end = border(target, source);
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 8 };
}

function border(from, to) {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  const scale = Math.min((NODE_W / 2) / (Math.abs(dx) || 0.001), (NODE_H / 2) / (Math.abs(dy) || 0.001));
  return { x: from.cx + dx * scale, y: from.cy + dy * scale };
}

function zoomToReaction(id) {
  const nodes = state.segments.filter((segment) => segment.reactionId === id).flatMap((segment) => [state.nodeById.get(segment.sourceId), state.nodeById.get(segment.targetId)]);
  fitBounds(Math.min(...nodes.map((node) => node.x)) - 240, Math.min(...nodes.map((node) => node.y)) - 220, Math.max(...nodes.map((node) => node.x + NODE_W)) + 240, Math.max(...nodes.map((node) => node.y + NODE_H)) + 220, true, 1.35);
}

function zoomToNode(id) {
  const node = state.nodeById.get(id);
  if (node) fitBounds(node.x - 360, node.y - 300, node.x + NODE_W + 360, node.y + NODE_H + 300, true, 1.55);
}

function zoomToGroup(id) {
  const nodes = state.nodes.filter((node) => node.group === id);
  state.activeNode = null;
  syncActive();
  fitBounds(Math.min(...nodes.map((node) => node.x)) - 260, Math.min(...nodes.map((node) => node.y)) - 240, Math.max(...nodes.map((node) => node.x + NODE_W)) + 260, Math.max(...nodes.map((node) => node.y + NODE_H)) + 240, true, 1.15);
}

function fitMap(animate = true) {
  fitBounds(Math.min(...state.nodes.map((node) => node.x)) - 420, Math.min(...state.nodes.map((node) => node.y)) - 420, Math.max(...state.nodes.map((node) => node.x + NODE_W)) + 420, Math.max(...state.nodes.map((node) => node.y + NODE_H)) + 420, animate, 0.95);
}

function fitBounds(minX, minY, maxX, maxY, animate, cap) {
  const rect = svg.node().getBoundingClientRect();
  const scale = Math.max(0.06, Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY), cap));
  const transform = d3.zoomIdentity.translate((rect.width - (maxX - minX) * scale) / 2 - minX * scale, (rect.height - (maxY - minY) * scale) / 2 - minY * scale).scale(scale);
  (animate ? svg.transition().duration(520) : svg).call(zoom.transform, transform);
}

function edgeColor(segment) {
  return segment.edge.display?.edge_color || state.ontology.metadata.chapter_colors[String(segment.edge.chapter)] || '#555';
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null))];
}

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
