use commitscope_core::{HistoryGraph, HistoryGraphSegment, HistoryGraphSegmentKind};
use std::mem::size_of;

pub const MAX_ACTIVE_SLOTS: usize = 16_384;
pub const MAX_LAYOUT_BYTES: usize = 2 * 1024 * 1024;
pub const CHECKPOINT_INTERVAL: u32 = 200;
pub const CHECKPOINT_LIMIT: usize = 64;
pub const CHECKPOINT_BYTES_LIMIT: usize = 8 * 1024 * 1024;
const MAX_SEGMENTS: usize = 256;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LayoutState {
    pub next_ordinal: u32,
    pub active_slots: Vec<Option<String>>,
    pub boundary_oid: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    pub next_ordinal: u32,
    pub boundary_oid: String,
    pub active_slots: Vec<Option<String>>,
    pub estimated_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayoutError {
    ResourceLimit,
}

impl LayoutState {
    pub fn estimated_bytes(&self) -> usize {
        self.active_slots
            .capacity()
            .saturating_mul(size_of::<Option<String>>())
            .saturating_add(
                self.active_slots
                    .iter()
                    .flatten()
                    .map(|oid| oid.capacity())
                    .sum::<usize>(),
            )
            .saturating_add(self.boundary_oid.as_ref().map_or(0, String::capacity))
    }

    pub fn advance(
        &mut self,
        oid: &str,
        parents: &[String],
        raw_parents: &[String],
    ) -> Result<HistoryGraph, LayoutError> {
        let before = &self.active_slots;
        let incoming = before
            .iter()
            .enumerate()
            .filter_map(|(slot, target)| (target.as_deref() == Some(oid)).then_some(slot))
            .collect::<Vec<_>>();
        let lane = incoming
            .first()
            .copied()
            .or_else(|| before.iter().position(Option::is_none))
            .unwrap_or(before.len());
        if lane >= MAX_ACTIVE_SLOTS {
            return Err(LayoutError::ResourceLimit);
        }

        let mut after = before.clone();
        for slot in &incoming {
            after[*slot] = None;
        }
        let mut outgoing_targets: Vec<(&String, usize)> = Vec::with_capacity(parents.len());
        for (parent_index, parent) in parents.iter().enumerate() {
            if outgoing_targets.iter().any(|(seen, _)| *seen == parent) {
                continue;
            }
            let target = if let Some(existing) = after
                .iter()
                .position(|candidate| candidate.as_deref() == Some(parent))
            {
                existing
            } else if parent_index == 0 {
                if lane >= after.len() {
                    after.resize(lane + 1, None);
                }
                after[lane] = Some(parent.clone());
                lane
            } else {
                let empty = after
                    .iter()
                    .enumerate()
                    .find_map(|(slot, value)| (value.is_none() && slot != lane).then_some(slot));
                let target = empty.unwrap_or_else(|| after.len().max(lane + 1));
                if target >= MAX_ACTIVE_SLOTS {
                    return Err(LayoutError::ResourceLimit);
                }
                if target >= after.len() {
                    after.resize(target + 1, None);
                }
                after[target] = Some(parent.clone());
                target
            };
            outgoing_targets.push((parent, target));
        }
        if parents.is_empty() && lane < after.len() {
            after[lane] = None;
        }
        while after.last().is_some_and(Option::is_none) {
            after.pop();
        }

        let mut above = 0_u8;
        for (slot, target) in before.iter().enumerate().take(6) {
            if target.is_some() {
                above |= 1 << slot;
            }
        }
        let mut below = 0_u8;
        for (slot, target) in after.iter().enumerate().take(6) {
            if target.is_some() {
                below |= 1 << slot;
            }
        }

        let mut hidden_slots = std::collections::HashSet::new();
        for (slot, target) in before.iter().enumerate() {
            if slot >= 6 && target.is_some() {
                hidden_slots.insert(slot);
            }
        }
        for (slot, target) in after.iter().enumerate() {
            if slot >= 6 && target.is_some() {
                hidden_slots.insert(slot);
            }
        }
        if lane >= 6 {
            hidden_slots.insert(lane);
        }

        let mut segments = Vec::new();
        for (slot, target) in before.iter().enumerate() {
            if slot < after.len()
                && target.is_some()
                && target.as_deref() != Some(oid)
                && after[slot] == *target
            {
                push_segment(
                    &mut segments,
                    HistoryGraphSegment {
                        kind: HistoryGraphSegmentKind::Through,
                        from_lane: slot as u16,
                        to_lane: slot as u16,
                        color: (slot % 6) as u8,
                    },
                )?;
            }
        }
        for slot in &incoming {
            push_segment(
                &mut segments,
                HistoryGraphSegment {
                    kind: HistoryGraphSegmentKind::Incoming,
                    from_lane: *slot as u16,
                    to_lane: lane as u16,
                    color: (*slot % 6) as u8,
                },
            )?;
        }
        for (_, target) in outgoing_targets {
            push_segment(
                &mut segments,
                HistoryGraphSegment {
                    kind: HistoryGraphSegmentKind::Outgoing,
                    from_lane: lane as u16,
                    to_lane: target as u16,
                    color: (target % 6) as u8,
                },
            )?;
        }

        if after.len() > MAX_ACTIVE_SLOTS {
            return Err(LayoutError::ResourceLimit);
        }
        let mut next = LayoutState {
            next_ordinal: self.next_ordinal.saturating_add(1),
            active_slots: after,
            boundary_oid: Some(oid.to_owned()),
        };
        if next.estimated_bytes() > MAX_LAYOUT_BYTES {
            return Err(LayoutError::ResourceLimit);
        }
        let graph = HistoryGraph {
            lane: lane as u16,
            color: (lane % 6) as u8,
            parents: parents.to_vec(),
            boundary: parents != raw_parents,
            above,
            below,
            hidden_lane_count: hidden_slots.len() as u16,
            segments,
        };
        *self = std::mem::take(&mut next);
        Ok(graph)
    }

    pub fn checkpoint(&self) -> Option<Checkpoint> {
        if self.next_ordinal == 0 || !self.next_ordinal.is_multiple_of(CHECKPOINT_INTERVAL) {
            return None;
        }
        let boundary_oid = self.boundary_oid.clone()?;
        let estimated_bytes = self.estimated_bytes() + boundary_oid.capacity() + 32;
        Some(Checkpoint {
            next_ordinal: self.next_ordinal,
            boundary_oid,
            active_slots: self.active_slots.clone(),
            estimated_bytes,
        })
    }
}

fn push_segment(
    segments: &mut Vec<HistoryGraphSegment>,
    segment: HistoryGraphSegment,
) -> Result<(), LayoutError> {
    if segment.from_lane >= 6 && segment.to_lane >= 6 {
        return Ok(());
    }
    if segments.len() >= MAX_SEGMENTS {
        return Err(LayoutError::ResourceLimit);
    }
    segments.push(segment);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parents(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn linear_history_stays_in_lane_zero_and_ends_empty() {
        let mut state = LayoutState::default();
        for (oid, parent) in [("a", "b"), ("b", "c")] {
            let graph = state
                .advance(oid, &[parent.into()], &[parent.into()])
                .unwrap();
            assert_eq!(graph.lane, 0);
            assert_eq!(graph.color, 0);
            assert_eq!(graph.parents, [parent]);
            assert_eq!(graph.below, 1);
            assert_eq!(
                graph
                    .segments
                    .iter()
                    .filter(|segment| segment.kind == HistoryGraphSegmentKind::Outgoing)
                    .count(),
                1
            );
        }
        let root = state.advance("c", &[], &[]).unwrap();
        assert_eq!(root.lane, 0);
        assert_eq!(root.above, 1);
        assert_eq!(root.below, 0);
        assert!(state.active_slots.is_empty());
    }

    #[test]
    fn merge_and_octopus_keep_parent_order_and_reuse_slots() {
        let mut state = LayoutState::default();
        let first = parents(&["b", "c", "d"]);
        let graph = state.advance("a", &first, &first).unwrap();
        assert_eq!(graph.lane, 0);
        assert_eq!(graph.below, 0b111);
        assert_eq!(graph.segments.len(), 3);

        let graph_b = state
            .advance("b", &parents(&["e"]), &parents(&["e"]))
            .unwrap();
        assert_eq!(graph_b.lane, 0);
        assert_eq!(graph_b.above, 0b111);
        assert_eq!(graph_b.below, 0b111);
        assert!(graph_b.segments.iter().any(|segment| {
            segment.kind == HistoryGraphSegmentKind::Through && segment.from_lane == 1
        }));

        let graph_c = state
            .advance("c", &parents(&["e"]), &parents(&["e"]))
            .unwrap();
        assert_eq!(graph_c.lane, 1);
        assert!(graph_c.segments.iter().any(|segment| {
            segment.kind == HistoryGraphSegmentKind::Outgoing
                && segment.from_lane == 1
                && segment.to_lane == 0
        }));

        let graph_d = state.advance("d", &[], &[]).unwrap();
        assert_eq!(graph_d.lane, 2);
        let graph_e = state.advance("e", &[], &[]).unwrap();
        assert_eq!(graph_e.lane, 0);
        assert!(state.active_slots.is_empty());
    }

    #[test]
    fn duplicate_parent_uses_one_target_slot_and_boundary_is_explicit() {
        let mut state = LayoutState::default();
        let duplicate = parents(&["b", "b"]);
        let graph = state.advance("a", &duplicate, &duplicate).unwrap();
        assert_eq!(
            graph
                .segments
                .iter()
                .filter(|segment| segment.kind == HistoryGraphSegmentKind::Outgoing)
                .count(),
            1
        );
        assert_eq!(graph.parents, duplicate);

        let grafted = state
            .advance("b", &parents(&["x"]), &parents(&["raw"]))
            .unwrap();
        assert!(grafted.boundary);
        assert_eq!(grafted.lane, 0);
    }

    #[test]
    fn hidden_projection_keeps_real_slots_and_lane_color_wraps() {
        let mut state = LayoutState {
            active_slots: (0..7).map(|slot| Some(format!("p{slot}"))).collect(),
            ..LayoutState::default()
        };
        let graph = state
            .advance(
                "p6",
                &parents(&["hidden-parent"]),
                &parents(&["hidden-parent"]),
            )
            .unwrap();
        assert_eq!(graph.lane, 6);
        assert_eq!(graph.color, 0);
        assert_eq!(graph.above, 0b11_1111);
        assert_eq!(graph.hidden_lane_count, 1);
        assert!(
            graph
                .segments
                .iter()
                .all(|segment| { segment.from_lane < 6 || segment.to_lane < 6 })
        );

        let mut wide = LayoutState {
            active_slots: (0..256).map(|slot| Some(format!("x{slot}"))).collect(),
            ..LayoutState::default()
        };
        let graph = wide.advance("new-root", &[], &[]).unwrap();
        assert_eq!(graph.lane, 256);
        assert_eq!(graph.color, 4);
    }

    #[test]
    fn checkpoint_is_emitted_at_fixed_ordinal_with_full_slots() {
        let mut state = LayoutState::default();
        for index in 0..CHECKPOINT_INTERVAL {
            state
                .advance(
                    &format!("c{index}"),
                    &parents(&["root"]),
                    &parents(&["root"]),
                )
                .unwrap();
        }
        let checkpoint = state.checkpoint().unwrap();
        assert_eq!(checkpoint.next_ordinal, 200);
        assert_eq!(checkpoint.boundary_oid, "c199");
        assert_eq!(checkpoint.active_slots, [Some("root".to_owned())]);
    }

    #[test]
    fn slot_limit_is_a_resource_error() {
        let mut state = LayoutState {
            active_slots: (0..MAX_ACTIVE_SLOTS)
                .map(|slot| Some(format!("p{slot}")))
                .collect(),
            ..LayoutState::default()
        };
        assert_eq!(
            state.advance("unseen", &[], &[]),
            Err(LayoutError::ResourceLimit)
        );
    }
}
