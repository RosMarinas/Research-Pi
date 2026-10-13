export function redactSensitiveText(value) {
	let text = String(value ?? "");
	text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]");
	text = text.replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED_API_KEY]");
	text = text.replace(
		/(\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[:=]\s*)[^\s,;]+/gi,
		"$1[REDACTED]",
	);
	return text;
}
