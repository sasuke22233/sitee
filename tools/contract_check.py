#!/usr/bin/env python3
"""Контрактный gate CI: docs/openapi.yaml должен 1:1 описывать роутер Go.

Источник истины — backend/internal/api/server.go. В спеке пути относительны
к servers.base (/api/v1), поэтому префикс снимается при сравнении.

Проверки:
  1. множество путей спекы = множество путей роутера (без /api/v1);
  2. каждый (путь, метод) роутера описан операцией в спеке;
  3. все $ref спеки разрешаются (нет битых ссылок).
"""
import sys

SPEC = 'docs/openapi.yaml'
ROUTER = 'backend/internal/api/server.go'
PREFIX = '/api/v1'
METHODS = ('get', 'post', 'patch', 'put', 'delete')


def router_pairs():
    """[(METHOD, /api/v1/...)] из mux.HandleFunc("GET /api/v1/shops", ...)."""
    pairs = []
    for line in open(ROUTER, encoding='utf-8').read().splitlines():
        if 'mux.HandleFunc(' not in line:
            continue
        head = line.split('mux.HandleFunc(', 1)[1]
        if '"' not in head:
            continue
        target = head.split('"', 2)[1]
        method, _, path = target.strip().partition(' ')
        if not path.startswith(PREFIX):
            continue
        pairs.append((method.upper(), path))
    return pairs


def spec_paths_and_ops():
    """({пути}, {(путь, метод)}) из секции paths: блок вида '  /a/b:' + '    get:'."""
    paths, ops = set(), set()
    cur = None
    in_paths = False
    for line in open(SPEC, encoding='utf-8').read().splitlines():
        stripped = line.strip()
        if stripped == 'paths:':
            in_paths = True
            continue
        if in_paths and stripped and not line.startswith(' '):
            break  # следующая секция верхнего уровня
        if not in_paths:
            continue
        if line.startswith('  /') and line.rstrip().endswith(':'):
            cur = line.strip()[:-1]
            paths.add(cur)
            continue
        word = stripped[:-1] if stripped.endswith(':') else ''
        if line.startswith('    ') and word in METHODS and cur:
            ops.add((cur, word))
    return paths, ops


def broken_refs():
    """$ref вида '#/components/<section>/<name>', у которых нет цели в спеке."""
    lines = open(SPEC, encoding='utf-8').read().splitlines()
    section, defined = None, set()
    for line in lines:
        if line.startswith('components:'):
            section = ''
            continue
        if section is None:
            continue
        if line.strip() == '':
            continue
        if not line.startswith(' '):
            section = None
            continue
        if line.startswith('  ') and not line.startswith('   ') and line.rstrip().endswith(':'):
            section = line.strip()[:-1]
            continue
        if not line.startswith('    ') or line.startswith('     '):
            continue
        stripped = line.strip()
        if stripped.endswith(':'):
            defined.add('components/' + section + '/' + stripped[:-1])
        elif ': {' in stripped:  # inline-маппинг: Name: { ... }
            defined.add('components/' + section + '/' + stripped.split(': {', 1)[0])
    missing = []
    for line in lines:
        i = line.find("$ref: '#/")
        if i < 0:
            continue
        target = line[i + len("$ref: '#/"):].split("'", 1)[0]
        if target not in defined:
            missing.append(target)
    return sorted(set(missing))


def main():
    problems = []
    pairs = router_pairs()
    routes = {p[len(PREFIX):] for _, p in pairs}
    paths, ops = spec_paths_and_ops()

    missing = sorted(routes - paths)
    extra = sorted(paths - routes)
    if missing:
        problems.append('Нет в openapi.yaml:' + ''.join('\n  ' + r for r in missing))
    if extra:
        problems.append('Нет в server.go:' + ''.join('\n  ' + r for r in extra))

    want = {(p[len(PREFIX):], m.lower()) for m, p in pairs}
    gap = sorted(want - ops)
    if gap:
        problems.append('Не описаны операции:' + ''.join('\n  %s %s' % (m.upper(), p) for p, m in gap))

    for ref in broken_refs():
        problems.append('Битый $ref: #/' + ref)

    if problems:
        print('\n'.join(problems))
        return 1
    print('openapi.yaml покрывает %d путей и %d операций API' % (len(routes), len(ops)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
