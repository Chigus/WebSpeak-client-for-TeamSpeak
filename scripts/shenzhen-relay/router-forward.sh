#!/bin/sh
# ASUS router only. The caller must save the existing vts_rulelist and pass its
# SHA256 to avoid overwriting a concurrent configuration change. No reboot.
set -eu
EXPECTED=${1:?Usage: sh router-forward.sh SAVED_VTS_RULELIST_SHA256}
case "$EXPECTED" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#EXPECTED}" = 64 ] || exit 1
[ "$(nvram get productid)" = RT-AX86U_PRO ] || [ "$(nvram get productid)" = RT-AX86UPro ] || {
    printf '%s\n' 'Unexpected router model.' >&2; exit 1;
}
[ "$(nvram get vts_enable_x)" = 1 ] || { printf '%s\n' 'Port forwarding is disabled.' >&2; exit 1; }
before=$(nvram get vts_rulelist)
actual=$(printf '%s' "$before" | sha256sum | awk '{print $1}')
[ "$actual" = "$EXPECTED" ] || { printf '%s\n' 'Router forwarding changed since backup.' >&2; exit 1; }
# Exact port conflicts are checked by the caller across ranges, protocols,
# existing listeners and plugins, as well as this final immediate check.
if iptables -t nat -S VSERVER | grep -E -- '--dport (5555|9988)( |$)' >/dev/null; then
    printf '%s\n' 'A requested public port already has a forwarding rule.' >&2
    exit 1
fi
wan_if=$(ip route show default | awk '/^default/ {for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')
[ -n "$wan_if" ] || exit 1
destination=192.168.50.227
after="$before<WebSpeak_SZ_TLS>5555>$destination>15555>TCP><WebSpeak_SZ_Voice>9988>$destination>19987>UDP>"
changed=0
success=0

nat_rule() {
    iptables -t nat "$1" VSERVER -p "$2" --dport "$3" \
        -m comment --comment "$5" -j DNAT --to-destination "$destination:$4"
}
forward_rule() {
    operation=$1
    if [ "$operation" = -I ]; then
        iptables -I FORWARD 1 -i "$wan_if" -o br0 -p "$2" -d "$destination" --dport "$3" \
            -m conntrack --ctstate DNAT -m comment --comment "$4" -j ACCEPT
    else
        iptables "$operation" FORWARD -i "$wan_if" -o br0 -p "$2" -d "$destination" --dport "$3" \
            -m conntrack --ctstate DNAT -m comment --comment "$4" -j ACCEPT
    fi
}
cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ "$success" = 0 ]; then
        nat_rule -D tcp 5555 15555 webspeak-sz-https 2>/dev/null || true
        nat_rule -D udp 9988 19987 webspeak-sz-voice 2>/dev/null || true
        forward_rule -D tcp 15555 webspeak-sz-https 2>/dev/null || true
        forward_rule -D udp 19987 webspeak-sz-voice 2>/dev/null || true
        if [ "$changed" = 1 ] && [ "$(nvram get vts_rulelist)" = "$after" ]; then
            nvram set "vts_rulelist=$before"
            nvram commit
        fi
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

nvram set "vts_rulelist=$after"
changed=1
nvram commit
[ "$(nvram get vts_rulelist)" = "$after" ] || exit 1
nat_rule -I tcp 5555 15555 webspeak-sz-https
nat_rule -I udp 9988 19987 webspeak-sz-voice
forward_rule -I tcp 15555 webspeak-sz-https
forward_rule -I udp 19987 webspeak-sz-voice
nat_rule -C tcp 5555 15555 webspeak-sz-https
nat_rule -C udp 9988 19987 webspeak-sz-voice
forward_rule -C tcp 15555 webspeak-sz-https
forward_rule -C udp 19987 webspeak-sz-voice
success=1
printf '%s\n' 'Saved and activated TCP 5555 -> 15555 and UDP 9988 -> 19987.'
