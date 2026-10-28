"""Maintainer-only: split the pinned Source Han Sans CN OTFs into WOFF2 shards.
Usage: uv run --with fonttools --with brotli python build-fonts.py RAW_DIR FONT_DIR
RAW_DIR contains source-han-sans/{SourceHanSansCN-{Regular,Bold}.otf,LICENSE.txt},
inter/{InterVariable.woff2,LICENSE.txt}, JetBrainsMono/{JetBrainsMono-Regular.woff2,OFL.txt}.
Normal HTML builds only use Node and the generated files; Python is not required.
"""
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from shutil import copyfile
from fontTools import subset
from fontTools.ttLib import TTFont


def ranges(points):
    out = []
    for cp in sorted(points):
        if out and cp == out[-1][1] + 1:
            out[-1][1] = cp
        else:
            out.append([cp, cp])
    return ','.join(f'U+{a:X}' if a == b else f'U+{a:X}-{b:X}' for a, b in out)


def shard(job):
    src, dst, points, weight = job
    font = TTFont(src)
    opts = subset.Options()
    opts.name_IDs = ['*']  # Preserve copyright and OFL metadata.
    sub = subset.Subsetter(options=opts)
    sub.populate(unicodes=points)
    sub.subset(font)
    # Modified fonts use a new family name (the upstream reserves "Source").
    style = 'Regular' if weight == 400 else 'Bold'
    names = {1: 'Research Han Sans', 2: style, 3: f'ResearchHanSans-{style}',
             4: f'Research Han Sans {style}', 6: f'ResearchHanSans-{style}',
             16: 'Research Han Sans', 17: style}
    for rec in font['name'].names:
        if rec.nameID in names:
            rec.string = names[rec.nameID].encode(rec.getEncoding())
    cff = font['CFF '].cff
    cff.fontNames = [f'ResearchHanSans-{style}']
    cff.topDictIndex[0].FamilyName = 'Research Han Sans'
    cff.topDictIndex[0].FullName = f'Research Han Sans {style}'
    font.flavor = 'woff2'
    font.save(dst)
    return {'family': 'Research Han Sans', 'weight': str(weight),
            'file': Path(dst).name, 'range': ranges(points)}


if __name__ == '__main__':
    raw, dest = map(Path, sys.argv[1:])
    dest.mkdir(parents=True, exist_ok=True)
    base = raw / 'source-han-sans'
    cmap = TTFont(base / 'SourceHanSansCN-Regular.otf').getBestCmap()
    # Put GB2312 level-1 characters first: common Chinese doesn't pull rare-glyph shards.
    common = []
    for lead in range(0xB0, 0xD8):
        for trail in range(0xA1, 0xFF):
            try:
                cp = ord(bytes([lead, trail]).decode('gb2312'))
                if cp in cmap:
                    common.append(cp)
            except UnicodeDecodeError:
                pass
    common_set = set(common)
    ordered = common + sorted(set(cmap) - common_set)
    groups = [ordered[i:i + 256] for i in range(0, len(ordered), 256)]
    jobs = [(base / f'SourceHanSansCN-{style}.otf', dest / f'han-{weight}-{i:03}.woff2', points, weight)
            for style, weight in [('Regular', 400), ('Bold', 700)] for i, points in enumerate(groups)]
    with ProcessPoolExecutor(max_workers=4) as pool:
        faces = list(pool.map(shard, jobs))
    for folder, filename, family, weight, licensefile in [
        ('inter', 'InterVariable.woff2', 'Inter', '100 900', 'LICENSE.txt'),
        ('JetBrainsMono', 'JetBrainsMono-Regular.woff2', 'JetBrains Mono', '400', 'OFL.txt'),
    ]:
        copyfile(raw / folder / filename, dest / filename)
        copyfile(raw / folder / licensefile, dest / f'{folder}-OFL.txt')
        faces.append({'family': family, 'weight': weight, 'file': filename})
    copyfile(base / 'LICENSE.txt', dest / 'source-han-sans-OFL.txt')
    (dest / 'manifest.json').write_text(json.dumps(faces, ensure_ascii=False, separators=(',', ':')) + '\n')
    css = []
    for face in faces:
        rule = f'@font-face{{font-family:"{face["family"]}";font-style:normal;font-weight:{face["weight"]};font-display:swap;src:url("{face["file"]}") format("woff2");'
        if 'range' in face:
            rule += f'unicode-range:{face["range"]};'
        css.append(rule + '}')
    (dest / 'fonts.css').write_text('\n'.join(css) + '\n')
    print(f'{len(cmap)} codepoints, {len(faces)} faces; WOFF2 total {sum(p.stat().st_size for p in dest.glob("*.woff2")) / 1024 / 1024:.2f} MiB')
