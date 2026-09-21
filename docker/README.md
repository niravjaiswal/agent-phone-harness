# Containerised virtual phones

`compose.yml` runs Android in a container via [redroid](https://github.com/remote-android/redroid-doc).

```bash
docker compose -f docker/compose.yml up -d
adb connect localhost:5555
agent-phone doctor          # should now list android:localhost:5555
```

## Requirements

- **Linux host.** redroid shares the host kernel and needs `binder` and `ashmem`.
  On macOS/Windows use `agent-phone up` instead — it drives a normal emulator.
- Matching architecture. On ARM hosts use an ARM redroid tag; x86 images under
  translation are too slow to drive interactively.

Load the kernel modules once if they are not already present:

```bash
sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"
sudo modprobe ashmem_linux
```

## Scaling

Copy the `phone-1` service block, bump the published port (5556, 5557, …) and give
it its own volume. Each container is one independent phone with its own `/data`,
so each can hold a different logged-in identity.

Note the same limits as any virtual device: no SIM, and Play Integrity will fail,
so attestation-gated apps (most banking) will refuse to run. See
`docs/compatibility.md`.
