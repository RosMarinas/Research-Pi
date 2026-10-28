#!/usr/bin/env python3
"""Package the dependency-free terminal bridge as a VSIX, without downloading a build toolchain."""
import json
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

root = Path(__file__).resolve().parents[1]
source = root / 'integrations/vscode-terminal'
package = json.loads((source / 'package.json').read_text())
out = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'output/research-pi-terminal.vsix'
out.parent.mkdir(parents=True, exist_ok=True)
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="{package['name']}" Version="{package['version']}" Publisher="{package['publisher']}"/><DisplayName>{escape(package['displayName'])}</DisplayName><Description xml:space="preserve">{escape(package['description'])}</Description><Tags>terminal</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{package['engines']['vscode']}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>'''
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('extension.vsixmanifest', manifest)
    archive.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>')
    for name in ['package.json', 'extension.cjs', 'README.md']:
        archive.write(source / name, 'extension/' + name)
    archive.write(root / 'LICENSE', 'extension/LICENSE')
print(out)
