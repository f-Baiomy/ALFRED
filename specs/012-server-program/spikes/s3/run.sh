#!/bin/sh
# Spike S3 inside one container: /jdk21 = the attacher (attach-cli on JDK 21), $JAVA_HOME = the target's JDK.
set -e
W=/tmp/s3
rm -rf $W && mkdir -p $W && cd $W
K=/jdk21/bin/keytool
P=changeit
$K -genkeypair -keyalg RSA -keysize 2048 -alias ca -dname CN=alfred-ca -ext bc:c -validity 30 -keystore ca.p12 -storetype PKCS12 -storepass $P -keypass $P >/dev/null 2>&1
$K -exportcert -rfc -alias ca -keystore ca.p12 -storepass $P -file ca.pem >/dev/null 2>&1
$K -genkeypair -keyalg RSA -keysize 2048 -alias server -dname CN=localhost -validity 30 -keystore server.p12 -storetype PKCS12 -storepass $P -keypass $P >/dev/null 2>&1
$K -certreq -alias server -keystore server.p12 -storepass $P -file server.csr >/dev/null 2>&1
$K -gencert -rfc -alias ca -keystore ca.p12 -storepass $P -infile server.csr -outfile server.pem -ext SAN=ip:127.0.0.1,dns:localhost -validity 30 >/dev/null 2>&1
$K -importcert -noprompt -alias ca -file ca.pem -keystore server.p12 -storepass $P >/dev/null 2>&1
$K -importcert -noprompt -alias server -file server.pem -keystore server.p12 -storepass $P >/dev/null 2>&1

cp /s3/S3Target.java . && "$JAVA_HOME/bin/javac" -nowarn -d . S3Target.java 2>&1 | grep -v "^Note:" || true
"$JAVA_HOME/bin/java" -version 2>&1 | head -1
"$JAVA_HOME/bin/java" -cp ".:/s3/lib/*" S3Target server.p12 > target.log 2>&1 &
i=0; until grep -q READY target.log; do i=$((i+1)); [ $i -gt 60 ] && { cat target.log; exit 1; }; sleep 0.5; done
PID=$(sed -n 's/^READY pid=//p' target.log)
ALFRED_AGENT_CA="$(cat ca.pem)" ALFRED_AGENT_SECRET=x /jdk21/bin/java -jar /s3/attach-cli.jar attach "$PID" \
  --agent /s3/alfred-agent.jar --args "alfredUrl=http://127.0.0.1:9;proxy=127.0.0.2:443" --add proxy || echo "attach exit $?"
wait
grep -E "RESULT|features=|alfred-agent" target.log
