// Runtime patch for a minecraft-data 3.117.0 defect (pin unchanged).
// pc/1.21.1 protocol.json lists 24 recipe serializers incl. "crafting_special_suspiciousstew", but a real 1.21.1
// server has 23 (that serializer is gone), so every id after it is shifted by one and the whole declare_recipes
// packet (~108 KB at login) fails to parse: minecraft-protocol logs a PartialReadError (surfacing as
// ArmorTrimMaterial/SlotComponent, because a smithing_trim recipe is read with the wrong layout) and DROPS the packet.
// Mineflayer does not use that packet, so the defect is harmless to behaviour; this patch just removes the noise
// and makes the packet parse. It is applied only if the data still has exactly the known-bad shape.
import mcdata from 'minecraft-data'

export function applyRecipeMappingFix(version = '1.21.1') {
  const data = mcdata(version)
  const t = data?.protocol?.play?.toClient?.types?.packet_declare_recipes
  const typeField = t?.[1]?.[0]?.type?.[1]?.type?.[1]?.[1]
  const mapper = typeField?.type?.[1]
  const mappings = mapper?.mappings
  if (!mappings) return { applied: false, reason: 'shape_unknown' }
  const names = Object.values(mappings)
  if (names.length !== 24 || names[14] !== 'minecraft:crafting_special_suspiciousstew') return { applied: false, reason: 'already_fixed_or_different' }
  const fixed = {}
  names.filter((n) => !n.endsWith('suspiciousstew')).forEach((n, i) => { fixed[i] = n })
  mapper.mappings = fixed
  return { applied: true }
}
