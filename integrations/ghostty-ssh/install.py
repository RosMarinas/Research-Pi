"""Idempotent user-only install, with an exact removable shell startup block."""
import os
from pathlib import Path
import shlex
import shutil
import sys

START = '# >>> Research Pi Ghostty SSH >>>'
END = '# <<< Research Pi Ghostty SSH <<<'


def configure(source, rc, action, target=None):
    target = target or Path.home() / 'Library/Application Support/Research Pi/ghostty-ssh'
    text = rc.read_text() if rc.exists() else ''
    if START in text:
        before, rest = text.split(START, 1)
        if END not in rest:
            raise ValueError('Incomplete existing Research Pi startup block; repair it before installing')
        _, after = rest.split(END, 1)
        text = before.rstrip('\n') + after
    if action == 'uninstall':
        rc.write_text(text)
        shutil.rmtree(target, ignore_errors=True)
        return
    if action != 'install':
        raise ValueError('Usage: install.sh [install|uninstall]')
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ('bridge.py', 'shell-integration.sh', 'install.py', 'install.sh'):
        if (source / name).resolve() != (target / name).resolve():
            shutil.copyfile(source / name, target / name)
        os.chmod(target / name, 0o600)
    if rc.exists():
        backup = rc.with_name(rc.name + '.before-research-pi-ghostty')
        if not backup.exists():
            shutil.copy2(rc, backup)
    block = '\n'.join([START,
        'export RESEARCH_PI_GHOSTTY_HOME=' + shlex.quote(str(target)),
        'export RESEARCH_PI_GHOSTTY_PYTHON=' + shlex.quote(sys.executable),
        '. "$RESEARCH_PI_GHOSTTY_HOME/shell-integration.sh"', END])
    rc.parent.mkdir(parents=True, exist_ok=True)
    rc.write_text(text.rstrip('\n') + '\n\n' + block + '\n')


if __name__ == '__main__':
    source, rc, action = sys.argv[1:]
    configure(Path(source), Path(rc), action)
    print('Research Pi Ghostty SSH ' + ('removed. Open a new terminal.' if action == 'uninstall' else
          'installed. Open a new Ghostty terminal, then use ssh as usual.'))
