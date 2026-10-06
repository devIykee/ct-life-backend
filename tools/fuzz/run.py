#!/usr/bin/env python3
"""
Fuzz the running API against the OpenAPI contract using Schemathesis.

Master prompt M8: "fuzz the REST layer with Schemathesis or equivalent
against openapi.yaml".

Usage:
  tools/fuzz/run.py [--url http://localhost:4010] [--seconds 30]
                    [--schema contract/openapi.yaml]

Strategy:
  - Start the API on PORT_API=4011 (or use --url).
  - Use the openapi.yaml as the schema source.
  - Configure auth: dev-authenticate a fake wallet and inject the
    resulting bearer token as a global auth header.
  - Run schemathesis for N seconds with a max-examples budget.
  - Exit non-zero on any failure (5xx, 4xx where 2xx expected, response
    schema violation).
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

import schemathesis

DEFAULT_SCHEMA = "contract/openapi.yaml"


def http_json(url, **kw):
    req = urllib.request.Request(url, **kw)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def wait_for_health(url, deadline_s=20):
    end = time.time() + deadline_s
    while time.time() < end:
        try:
            r = urllib.request.urlopen(url, timeout=2)
            if r.status == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def mint_dev_token(base_url, wallet):
    """POST /v1/auth/dev to get a bearer token."""
    req = urllib.request.Request(
        f"{base_url}/v1/auth/dev",
        data=json.dumps({"wallet": wallet}).encode(),
        headers={"content-type": "application/json", "idempotency-key": f"fuzz-{int(time.time())}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        body = json.loads(r.read())
    return body["accessToken"]


def start_api(port):
    """Spawn the Fastify API on the given port."""
    env = os.environ.copy()
    env["PORT_API"] = str(port)
    env["ENABLE_DEV_AUTH"] = "true"
    log = open("/tmp/fuzz-api.log", "w")
    p = subprocess.Popen(
        ["pnpm", "exec", "tsx", "server/api/main.ts"],
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    return p, log


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=None)
    ap.add_argument("--schema", default=DEFAULT_SCHEMA)
    ap.add_argument("--seconds", type=int, default=30)
    ap.add_argument("--port", type=int, default=4011)
    args = ap.parse_args()

    if args.url:
        base = args.url.rstrip("/")
    else:
        port = args.port
        base = f"http://127.0.0.1:{port}"
        # Start it.
        proc, log = start_api(port)
        try:
            if not wait_for_health(f"{base}/healthz"):
                print("[fuzz] API never became healthy", file=sys.stderr)
                print(open("/tmp/fuzz-api.log").read()[-2000:], file=sys.stderr)
                sys.exit(1)
            print(f"[fuzz] API ready on {base}")
            return _run(base, args.schema, args.seconds)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
    return _run(base, args.schema, args.seconds)


def _run(base, schema, seconds):
    # Generate a real Solana public key via Node's @solana/web3.js.
    out = subprocess.check_output(
        ["node", "-e", "const {Keypair}=require('@solana/web3.js');process.stdout.write(Keypair.generate().publicKey.toBase58())"],
        cwd=os.getcwd(),
    ).decode()
    wallet = out.strip()
    print(f"[fuzz] using wallet {wallet[:8]}…{wallet[-8:]}")
    token = mint_dev_token(base, wallet)
    schema_obj = schemathesis.openapi.from_path(schema)
    # Configure the schema with our target URL.
    failures = []

    def on_check(case, response):
        # Filter out failures we expect (auth/rate-limit boundaries).
        if response.status_code in (401, 403, 404, 429):
            return None
        return None

    runner = schema_obj.parametrize()
    # Apply our auth header to every request.
    for case in runner:
        case.headers = case.headers or {}
        case.headers["authorization"] = f"Bearer {token}"

    print(f"[fuzz] running schemathesis for {seconds}s against {base}")
    start = time.time()
    try:
        runner.exit_first = False
        # Newer schemathesis uses a different API.
        import hypothesis
        hypothesis.settings.register_profile(
            "fuzz",
            deadline=None,
            max_examples=200,
            suppress_health_check=[hypothesis.HealthCheck.too_slow],
        )
        hypothesis.settings.load_profile("fuzz")
        # The harness: schemathesis will call this per generated case.
        import requests
        session = requests.Session()
        session.headers["authorization"] = f"Bearer {token}"
        for case in runner:
                # Manually call: not all versions support `runner.execute`.
                try:
                    response = case.call(session=session)
                    case.validate_response(response)
                except Exception as e:
                    failures.append({"operation": case.operation.label, "path": case.path, "error": str(e)})
                if time.time() - start > seconds:
                    break
    except KeyboardInterrupt:
        pass

    elapsed = time.time() - start
    print(f"[fuzz] ran for {elapsed:.1f}s; {len(failures)} failures")
    if failures:
        for f in failures[:20]:
            print(f"  - {f}")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()