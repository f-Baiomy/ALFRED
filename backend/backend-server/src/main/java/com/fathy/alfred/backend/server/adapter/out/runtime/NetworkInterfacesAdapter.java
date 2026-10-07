package com.fathy.alfred.backend.server.adapter.out.runtime;

import com.fathy.alfred.backend.server.application.port.out.LocalAddressesPort;

import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/** The addresses of this machine's network interfaces (read per call: a laptop's address can change). */
public class NetworkInterfacesAdapter implements LocalAddressesPort {

    @Override
    public Set<String> addresses() {
        Set<String> out = new HashSet<>();
        try {
            for (NetworkInterface nic : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                for (InetAddress address : Collections.list(nic.getInetAddresses())) {
                    String text = address.getHostAddress();
                    int zone = text.indexOf('%');
                    out.add(zone >= 0 ? text.substring(0, zone) : text);
                }
            }
        } catch (SocketException e) {
            return Set.of();
        }
        return out;
    }
}
