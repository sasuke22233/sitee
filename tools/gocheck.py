import glob


def strip(src):
    out = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            while i < n and src[i] != '\n':
                i += 1
        elif c == '/' and i + 1 < n and src[i + 1] == '*':
            i += 2
            while i + 1 < n and not (src[i] == '*' and src[i + 1] == '/'):
                i += 1
            i += 2
        elif c == '"':
            i += 1
            while i < n and src[i] != '"':
                i += 2 if src[i] == '\\' else 1
            i += 1
        elif c == '`':
            i += 1
            while i < n and src[i] != '`':
                i += 1
            i += 1
        elif c == "'":
            i += 1
            while i < n and src[i] != "'":
                i += 2 if src[i] == '\\' else 1
            i += 1
        else:
            out.append(c)
            i += 1
    return ''.join(out)


files = sorted(glob.glob('backend/**/*.go', recursive=True))
bad = []
for f in files:
    s = strip(open(f, encoding='utf-8').read())
    for o, c in (('{', '}'), ('(', ')'), ('[', ']')):
        if s.count(o) != s.count(c):
            bad.append(f'{f}: {o}{c} {s.count(o)}/{s.count(c)}')
print('Go-файлов проверено:', len(files))
print('дисбаланс:', bad or 'НЕТ')
