/**
 * Formats a VPN filename into a user-friendly location name.
 * @param {string} filename - The name of the VPN config file.
 * @returns {string} The formatted location/name.
 */
function formatVpnLocation(filename) {
  if (!filename) return '';
  // Remove .ovpn extension (case insensitive)
  let name = filename.replace(/\.ovpn$/i, '');
  // Replace hyphens and underscores with spaces
  name = name.replace(/[-_]/g, ' ');
  // Clean up NCVPN prefix
  if (name.startsWith('NCVPN ')) {
    name = name.slice(6);
  }
  // Clean up VPNGate style names: e.g. "vpngate_219.100.37.5_tcp_443 (1).ovpn" -> "VPN Gate (Japan #5)"
  if (name.toLowerCase().startsWith('vpngate ')) {
    name = name.slice(8);
    const parts = name.split(' ');
    if (parts[0]) {
      let location = parts[0];
      if (location.startsWith('219.100.37.')) {
        const octets = location.split('.');
        location = `Japan #${octets[3]}`;
      }
      name = `VPN Gate (${location})`;
    }
  }
  return name;
}

module.exports = { formatVpnLocation };
