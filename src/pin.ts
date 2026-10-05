export function pinScript(url: URL): string {
  try {
    const request = new XMLHttpRequest();
    request.open('GET', url.href, false);
    request.send();
    if (request.status !== 200) return url.href;
    const source = `${request.responseText}\n//# sourceURL=${url.href}\n`;
    return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  } catch {
    return url.href;
  }
}
