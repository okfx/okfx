use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub const CRATE_NAME: &str = "okfx_core";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Advice,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
}

pub fn crate_name() -> &'static str {
    CRATE_NAME
}

pub fn find_representative_cycles(
    node_ids: &BTreeSet<String>,
    outgoing: &BTreeMap<String, BTreeSet<String>>,
) -> Vec<Vec<String>> {
    let mut reverse = node_ids
        .iter()
        .map(|id| (id.clone(), BTreeSet::new()))
        .collect::<BTreeMap<_, _>>();
    for (source, targets) in outgoing {
        if !node_ids.contains(source) {
            continue;
        }
        for target in targets.iter().filter(|target| node_ids.contains(*target)) {
            reverse
                .entry(target.clone())
                .or_default()
                .insert(source.clone());
        }
    }

    let mut finish_order = Vec::new();
    let mut visited = BTreeSet::new();
    for start in node_ids {
        if visited.contains(start) {
            continue;
        }
        let mut stack = vec![(start.clone(), false)];
        while let Some((current, expanded)) = stack.pop() {
            if expanded {
                finish_order.push(current);
                continue;
            }
            if !visited.insert(current.clone()) {
                continue;
            }
            stack.push((current.clone(), true));
            if let Some(neighbors) = outgoing.get(&current) {
                for neighbor in neighbors.iter().rev() {
                    if node_ids.contains(neighbor) && !visited.contains(neighbor) {
                        stack.push((neighbor.clone(), false));
                    }
                }
            }
        }
    }

    let mut assigned = BTreeSet::new();
    let mut components = Vec::new();
    for start in finish_order.into_iter().rev() {
        if !assigned.insert(start.clone()) {
            continue;
        }
        let mut component = Vec::new();
        let mut stack = vec![start];
        while let Some(current) = stack.pop() {
            component.push(current.clone());
            if let Some(neighbors) = reverse.get(&current) {
                for neighbor in neighbors.iter().rev() {
                    if assigned.insert(neighbor.clone()) {
                        stack.push(neighbor.clone());
                    }
                }
            }
        }
        component.sort();
        components.push(component);
    }

    let mut cycles = components
        .into_iter()
        .filter(|component| {
            component.len() > 1
                || outgoing
                    .get(&component[0])
                    .is_some_and(|targets| targets.contains(&component[0]))
        })
        .map(|component| representative_cycle(&component, outgoing))
        .collect::<Vec<_>>();
    cycles.sort();
    cycles
}

fn representative_cycle(
    component: &[String],
    outgoing: &BTreeMap<String, BTreeSet<String>>,
) -> Vec<String> {
    let start = &component[0];
    if component.len() == 1 {
        return vec![start.clone(), start.clone()];
    }

    let members = component.iter().collect::<BTreeSet<_>>();
    if let Some(first_steps) = outgoing.get(start) {
        for first_step in first_steps
            .iter()
            .filter(|next| *next != start && members.contains(next))
        {
            if let Some(path) = find_path(first_step, start, &members, outgoing) {
                return std::iter::once(start.clone()).chain(path).collect();
            }
        }
    }

    unreachable!("strongly connected component must contain a representative cycle")
}

fn find_path(
    from: &str,
    to: &str,
    members: &BTreeSet<&String>,
    outgoing: &BTreeMap<String, BTreeSet<String>>,
) -> Option<Vec<String>> {
    let mut parents = BTreeMap::from([(from.to_string(), None::<String>)]);
    let mut queue = VecDeque::from([from.to_string()]);

    while let Some(current) = queue.pop_front() {
        if current == to {
            let mut path = Vec::new();
            let mut cursor = Some(current);
            while let Some(id) = cursor {
                cursor = parents.get(&id).cloned().flatten();
                path.push(id);
            }
            path.reverse();
            return Some(path);
        }

        if let Some(neighbors) = outgoing.get(&current) {
            for neighbor in neighbors {
                if members.contains(neighbor) && !parents.contains_key(neighbor) {
                    parents.insert(neighbor.clone(), Some(current.clone()));
                    queue.push_back(neighbor.clone());
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_crate_name() {
        assert_eq!(crate_name(), "okfx_core");
    }

    #[test]
    fn finds_one_representative_cycle_per_component() {
        let node_ids = ["a", "b", "c", "d"]
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<_>>();
        let outgoing = BTreeMap::from([
            ("a".to_string(), BTreeSet::from(["b".to_string()])),
            ("b".to_string(), BTreeSet::from(["c".to_string()])),
            (
                "c".to_string(),
                BTreeSet::from(["a".to_string(), "b".to_string()]),
            ),
            ("d".to_string(), BTreeSet::new()),
        ]);

        assert_eq!(
            find_representative_cycles(&node_ids, &outgoing),
            vec![vec!["a", "b", "c", "a"]]
        );
    }
}
