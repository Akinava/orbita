#!/bin/sh
# /usr/local/sbin/firewall.sh — host INPUT rules for orbita.
# Docker manages FORWARD/nat itself; we only touch INPUT, so restarts of dockerd don't conflict.
set -e

for IPT in iptables ip6tables; do
  $IPT -P INPUT ACCEPT
  $IPT -F INPUT

  $IPT -A INPUT -i lo -j ACCEPT
  $IPT -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  $IPT -A INPUT -m conntrack --ctstate INVALID -j DROP

  # containers -> host (coturn on host network, etc.)
  $IPT -A INPUT -i docker0 -j ACCEPT
  $IPT -A INPUT -i br-+ -j ACCEPT

  # SSH: max 10 new connections per minute per IP. --rcheck (not --update) so that
  # dropped SYN retransmits don't keep extending the lockout window.
  $IPT -A INPUT -p tcp --dport 22 -m conntrack --ctstate NEW -m recent --name ssh --rcheck --seconds 60 --hitcount 10 -j DROP
  $IPT -A INPUT -p tcp --dport 22 -m conntrack --ctstate NEW -m recent --name ssh --set
  $IPT -A INPUT -p tcp --dport 22 -j ACCEPT

  # HTTPS (IPv4 goes via DNAT/FORWARD, IPv6 via docker-proxy on INPUT)
  $IPT -A INPUT -p tcp --dport 443 -j ACCEPT
done

# IPv4-only bits
iptables -A INPUT -p icmp -j ACCEPT
iptables -A INPUT -p udp --sport 67 --dport 68 -j ACCEPT          # DHCP
iptables -A INPUT -p tcp -m multiport --dports 3478,5349 -j ACCEPT # TURN
iptables -A INPUT -p udp -m multiport --dports 3478,5349 -j ACCEPT
iptables -A INPUT -p udp --dport 49160:49200 -j ACCEPT            # TURN relay range

# IPv6 needs ICMPv6 for neighbor discovery / PMTU
ip6tables -A INPUT -p ipv6-icmp -j ACCEPT
ip6tables -A INPUT -p udp --sport 547 --dport 546 -j ACCEPT        # DHCPv6

iptables -P INPUT DROP
ip6tables -P INPUT DROP
