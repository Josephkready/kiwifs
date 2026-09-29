---
title: Network Segmentation Design — VLANs for Trusted, IoT and Guest traffic with one-way firewalling
tags: [networking, home-lab, security, design]
created: 2026-09-20
updated: 2026-09-28
status: proposed
---

# Network Segmentation Design

Split the flat `10.0.0.0/24` LAN into three VLANs so a compromised IoT device cannot reach the
trusted machines. Related: [[garden-plan-2026q4]] (the irrigation controller is an IoT device) and
[[ada-lovelace]] (no relation, just a link to test navigation).

## Goals

1. Trusted machines keep `10.0.0.0/24`.
2. IoT moves to VLAN 20 with client isolation.
3. Guests get VLAN 30 with internet only.

## VLAN plan

| VLAN | Name | Subnet | DHCP range | Firewall to Trusted | Firewall to Internet | Notes |
|---|---|---|---|---|---|---|
| 1 | Trusted | 10.0.0.0/24 | .100–.199 | — | allow | wired machines and the dev box |
| 20 | IoT | 10.0.20.0/24 | .100–.250 | deny (established only) | allow | plugs, TV, irrigation controller |
| 30 | Guest | 10.0.30.0/24 | .100–.250 | deny | allow | isolated, rate limited to 50 Mbit/s |

## Router config

```sh
uci set network.iot=interface
uci set network.iot.proto='static'
uci set network.iot.ipaddr='10.0.20.1'
uci set firewall.iot_to_lan=rule; uci set firewall.iot_to_lan.src='iot'; uci set firewall.iot_to_lan.dest='lan'; uci set firewall.iot_to_lan.target='REJECT'
uci commit && /etc/init.d/network reload
```

## Rollout

- [x] Inventory every device and its MAC address
- [x] Pick subnets
- [ ] Build the config with auto-revert
- [ ] Cut over during a quiet evening

### Rollback

If anything breaks, the router reverts after five minutes unless the change is confirmed. Reference:
https://openwrt.org/docs/guide-user/network/vlan/switch_configuration_and_a_very_long_path_segment_that_does_not_break

## Open questions

> Does the TV's casting still work across VLANs? Probably needs an mDNS reflector.
