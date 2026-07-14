use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DockEdge {
    Left,
    Right,
    Top,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DockMode {
    Hidden,
    Peek,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockState {
    pub edge: DockEdge,
    pub cross: f64,
    pub monitor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub const SNAP_THRESHOLD: f64 = 12.0;
pub const BEAD_THICKNESS: f64 = 14.0;
pub const BEAD_LENGTH: f64 = 56.0;
pub const PILL_W: f64 = 220.0;
pub const PILL_H: f64 = 72.0;

pub fn detect_dock_edge(win: Rect, work: Rect) -> Option<DockEdge> {
    let left = (win.x - work.x).abs();
    let right = (work.x + work.w - (win.x + win.w)).abs();
    let top = (win.y - work.y).abs();

    let mut best = None;
    let mut best_distance = f64::INFINITY;
    for (edge, distance) in [
        (DockEdge::Left, left),
        (DockEdge::Right, right),
        (DockEdge::Top, top),
    ] {
        if distance <= SNAP_THRESHOLD && distance < best_distance {
            best = Some(edge);
            best_distance = distance;
        }
    }
    best
}

pub fn dock_geometry(edge: DockEdge, mode: DockMode, cross: f64, work: Rect, pill_h: f64) -> Rect {
    match (edge, mode) {
        (DockEdge::Left, DockMode::Hidden) => Rect {
            x: work.x,
            y: clamp(cross, work.y, work.y + work.h - BEAD_LENGTH),
            w: BEAD_THICKNESS,
            h: BEAD_LENGTH,
        },
        (DockEdge::Right, DockMode::Hidden) => Rect {
            x: work.x + work.w - BEAD_THICKNESS,
            y: clamp(cross, work.y, work.y + work.h - BEAD_LENGTH),
            w: BEAD_THICKNESS,
            h: BEAD_LENGTH,
        },
        (DockEdge::Top, DockMode::Hidden) => Rect {
            x: clamp(cross, work.x, work.x + work.w - BEAD_LENGTH),
            y: work.y,
            w: BEAD_LENGTH,
            h: BEAD_THICKNESS,
        },
        (DockEdge::Left, DockMode::Peek) => Rect {
            x: work.x,
            y: clamp(cross, work.y, work.y + work.h - pill_h),
            w: PILL_W,
            h: pill_h,
        },
        (DockEdge::Right, DockMode::Peek) => Rect {
            x: work.x + work.w - PILL_W,
            y: clamp(cross, work.y, work.y + work.h - pill_h),
            w: PILL_W,
            h: pill_h,
        },
        (DockEdge::Top, DockMode::Peek) => Rect {
            x: clamp(cross, work.x, work.x + work.w - PILL_W),
            y: work.y,
            w: PILL_W,
            h: pill_h,
        },
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work() -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            w: 1920.0,
            h: 1040.0,
        }
    }

    fn assert_rect(actual: Rect, expected: Rect) {
        let epsilon = 0.001;
        assert!((actual.x - expected.x).abs() < epsilon, "x: {actual:?}");
        assert!((actual.y - expected.y).abs() < epsilon, "y: {actual:?}");
        assert!((actual.w - expected.w).abs() < epsilon, "w: {actual:?}");
        assert!((actual.h - expected.h).abs() < epsilon, "h: {actual:?}");
    }

    #[test]
    fn detects_supported_edges_at_threshold() {
        assert_eq!(
            detect_dock_edge(
                Rect {
                    x: 12.0,
                    y: 100.0,
                    w: PILL_W,
                    h: PILL_H,
                },
                work(),
            ),
            Some(DockEdge::Left)
        );
        assert_eq!(
            detect_dock_edge(
                Rect {
                    x: 1688.0,
                    y: 100.0,
                    w: PILL_W,
                    h: PILL_H,
                },
                work(),
            ),
            Some(DockEdge::Right)
        );
        assert_eq!(
            detect_dock_edge(
                Rect {
                    x: 100.0,
                    y: 12.0,
                    w: PILL_W,
                    h: PILL_H,
                },
                work(),
            ),
            Some(DockEdge::Top)
        );
    }

    #[test]
    fn ignores_edges_outside_threshold() {
        assert_eq!(
            detect_dock_edge(
                Rect {
                    x: 13.0,
                    y: 100.0,
                    w: PILL_W,
                    h: PILL_H,
                },
                work(),
            ),
            None
        );
    }

    #[test]
    fn corners_use_nearest_edge_and_prefer_side_on_tie() {
        assert_eq!(
            detect_dock_edge(
                Rect {
                    x: 8.0,
                    y: 3.0,
                    w: PILL_W,
                    h: PILL_H,
                },
                work(),
            ),
            Some(DockEdge::Top)
        );
        assert_eq!(
            detect_dock_edge(
                Rect {
                    x: 8.0,
                    y: 8.0,
                    w: PILL_W,
                    h: PILL_H,
                },
                work(),
            ),
            Some(DockEdge::Left)
        );
    }

    #[test]
    fn calculates_hidden_and_peek_geometry() {
        assert_rect(
            dock_geometry(DockEdge::Right, DockMode::Hidden, 200.0, work(), PILL_H),
            Rect {
                x: 1906.0,
                y: 200.0,
                w: BEAD_THICKNESS,
                h: BEAD_LENGTH,
            },
        );
        assert_rect(
            dock_geometry(DockEdge::Left, DockMode::Hidden, 200.0, work(), PILL_H),
            Rect {
                x: 0.0,
                y: 200.0,
                w: BEAD_THICKNESS,
                h: BEAD_LENGTH,
            },
        );
        assert_rect(
            dock_geometry(DockEdge::Top, DockMode::Hidden, 200.0, work(), PILL_H),
            Rect {
                x: 200.0,
                y: 0.0,
                w: BEAD_LENGTH,
                h: BEAD_THICKNESS,
            },
        );
        assert_rect(
            dock_geometry(DockEdge::Right, DockMode::Peek, 200.0, work(), 300.0),
            Rect {
                x: 1700.0,
                y: 200.0,
                w: PILL_W,
                h: 300.0,
            },
        );
        assert_rect(
            dock_geometry(DockEdge::Top, DockMode::Peek, 200.0, work(), 300.0),
            Rect {
                x: 200.0,
                y: 0.0,
                w: PILL_W,
                h: 300.0,
            },
        );
    }

    #[test]
    fn clamps_cross_axis_inside_work_area() {
        assert_rect(
            dock_geometry(DockEdge::Right, DockMode::Hidden, -20.0, work(), PILL_H),
            Rect {
                x: 1906.0,
                y: 0.0,
                w: BEAD_THICKNESS,
                h: BEAD_LENGTH,
            },
        );
        assert_rect(
            dock_geometry(DockEdge::Top, DockMode::Peek, 1900.0, work(), PILL_H),
            Rect {
                x: 1700.0,
                y: 0.0,
                w: PILL_W,
                h: PILL_H,
            },
        );
    }

    #[test]
    fn calculates_geometry_in_scaled_logical_work_areas() {
        let scaled_work = Rect {
            x: 100.0,
            y: 50.0,
            w: 1280.0,
            h: 720.0,
        };

        assert_rect(
            dock_geometry(DockEdge::Right, DockMode::Hidden, 900.0, scaled_work, PILL_H),
            Rect {
                x: 1366.0,
                y: 714.0,
                w: BEAD_THICKNESS,
                h: BEAD_LENGTH,
            },
        );
        assert_rect(
            dock_geometry(DockEdge::Top, DockMode::Peek, 1500.0, scaled_work, 300.0),
            Rect {
                x: 1160.0,
                y: 50.0,
                w: PILL_W,
                h: 300.0,
            },
        );
    }
}
