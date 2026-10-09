#!/bin/sh
# Restore only this deployment's existing, enabled NVRAM forwards. Some ASUS
# firmware/plugin NAT rebuilds omit appended entries from a long rule list.
set -eu
lock=/tmp/webspeak-sz-forward.lock
mkdir "$lock" 2>/dev/null || exit 0
trap 'rmdir "$lock" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM
[ "$(nvram get vts_enable_x)" = 1 ] || exit 0
saved=$(nvram get vts_rulelist)
destination=192.168.50.227
wan_if=$(ip route show default | awk '/^default/ {for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')
[ -n "$wan_if" ] || exit 1

restore() {
    protocol=$1 public=$2 private=$3 name=$4 comment=$5
    case "$saved" in *"<$name>$public>$destination>$private>$6>"*) ;; *) return 0 ;; esac
    # Refuse an existing forward to another destination; never replace it.
    matches=$(iptables -t nat -S VSERVER | awk -v proto="$protocol" -v port="$public" '
      { p=""; d=""; for(i=1;i<=NF;i++) { if($i=="-p")p=$(i+1); if($i=="--dport")d=$(i+1) }
        if(p==proto && d==port) print }')
    if [ -n "$matches" ]; then
        printf '%s\n' "$matches" | awk -v target="$destination:$private" '
          { found=0; for(i=1;i<=NF;i++) if($i=="--to-destination" && $(i+1)==target)found=1; if(!found)exit 1 }' || {
            logger -t webspeak-sz-forward "Conflict on $protocol $public; leaving existing rules intact."
            return 1
        }
    else
        iptables -t nat -I VSERVER -p "$protocol" --dport "$public" -m comment --comment "$comment" -j DNAT --to-destination "$destination:$private"
    fi
    iptables -C FORWARD -i "$wan_if" -o br0 -p "$protocol" -d "$destination" --dport "$private" -m conntrack --ctstate DNAT -m comment --comment "$comment" -j ACCEPT 2>/dev/null ||
        iptables -I FORWARD 1 -i "$wan_if" -o br0 -p "$protocol" -d "$destination" --dport "$private" -m conntrack --ctstate DNAT -m comment --comment "$comment" -j ACCEPT
}
restore tcp 5555 15555 WebSpeak_SZ_TLS webspeak-sz-https TCP
restore udp 9988 19987 WebSpeak_SZ_Voice webspeak-sz-voice UDP
