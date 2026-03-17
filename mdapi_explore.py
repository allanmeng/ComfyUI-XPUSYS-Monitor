"""
MDAPI exploration — step by step, validates each vtable call before proceeding.
"""
import ctypes, sys

dll = r'C:/Windows/System32/DriverStore/FileRepository/iigd_dch_d.inf_amd64_cf8aa2310532d3cb/igdmd64.dll'
lib = ctypes.WinDLL(dll)
lib.OpenMetricsDevice.restype  = ctypes.c_int
lib.OpenMetricsDevice.argtypes = [ctypes.POINTER(ctypes.c_void_p)]

dev = ctypes.c_void_p()
assert lib.OpenMetricsDevice(ctypes.byref(dev)) == 0 and dev.value, "OpenMetricsDevice failed"
print(f"Device: {dev.value:#x}")
sys.stdout.flush()

# ---- helpers ----------------------------------------------------------------

def vt(obj_addr):
    """Return vtable pointer array for obj at obj_addr (int)."""
    vt_addr = ctypes.cast(obj_addr, ctypes.POINTER(ctypes.c_void_p))[0]
    return ctypes.cast(vt_addr, ctypes.POINTER(ctypes.c_void_p))

def rstr(addr):
    if not addr: return "<null>"
    try:   return ctypes.cast(addr, ctypes.c_char_p).value.decode("utf-8", errors="replace")
    except: return "<?>"

def ru32(base, off):
    return ctypes.cast(base + off, ctypes.POINTER(ctypes.c_uint32))[0]

def rptr(base, off):
    return ctypes.cast(base + off, ctypes.POINTER(ctypes.c_void_p))[0]

# ---- Discover correct vtable slots for Device -------------------------------

dev_vt = vt(dev.value)

# We know [1]=GetParams, [3]=GetGlobalSymbol. Scan [2] for GetConcurrentGroup:
# Strategy: call each candidate slot with index=0, validate the result is non-null
# and that its first field looks like a valid vtable (readable memory in high address range).

# Build typed callers
def make_fn_u32arg(slot):
    return ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32)(dev_vt[slot])

def make_fn_noarg(slot):
    return ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p)(dev_vt[slot])

print("\n--- Validating Device vtable slots 0-8 ---")
for slot in range(9):
    try:
        fn = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32)(dev_vt[slot])
        result = fn(dev, 0)
        print(f"  slot[{slot}](dev,0) -> {result:#x if result else 0}")
    except Exception as e:
        print(f"  slot[{slot}] exception: {e}")
    sys.stdout.flush()

print()

# ---- Identify GetConcurrentGroup slot ---------------------------------------
# GetParams (slot 1) returned a params struct, not a Group object.
# GetConcurrentGroup should return an opaque object with its own vtable.
# We look for a slot whose result has a plausible vtable (high address, not in range of params struct).

LIKELY_CG_SLOTS = [2, 3, 4]
for slot in LIKELY_CG_SLOTS:
    fn = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32)(dev_vt[slot])
    result = fn(dev, 0)
    if not result:
        continue
    # Try to read its vtable pointer
    try:
        inner_vt_addr = ctypes.cast(result, ctypes.POINTER(ctypes.c_void_p))[0]
        inner_fn0 = ctypes.cast(inner_vt_addr, ctypes.POINTER(ctypes.c_void_p))[0]
        # Try calling inner vtable[1] (GetParams equivalent)
        inner_getparams = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p)(
            ctypes.cast(inner_vt_addr, ctypes.POINTER(ctypes.c_void_p))[1]
        )
        params = inner_getparams(result)
        if params:
            name_ptr = rptr(params, 0)
            name = rstr(name_ptr)
            set_count_candidates = [ru32(params, off) for off in (16, 20, 24)]
            print(f"  slot[{slot}] -> Group? name={name!r} u32@16/20/24={set_count_candidates}")
    except Exception as e:
        print(f"  slot[{slot}] inner read exception: {e}")
    sys.stdout.flush()

print()

# ---- Enumerate groups using discovered slot ---------------------------------
# Use slot 2 as GetConcurrentGroup (most likely based on class definition)
GetCG = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32)(dev_vt[2])

print("--- Scanning 16 groups ---")
power_hits = []

for gi in range(16):
    try:
        grp = GetCG(dev, gi)
    except Exception as e:
        print(f"Group[{gi}] GetCG exception: {e}"); sys.stdout.flush(); continue
    if not grp:
        continue

    try:
        g_vt = vt(grp)
        GetGP = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p)(g_vt[1])
        gp = GetGP(grp)
        if not gp:
            print(f"Group[{gi}] GetParams -> null"); sys.stdout.flush(); continue

        grp_name = rstr(rptr(gp, 0))
        # Try multiple offsets for MetricSetsCount
        for off in (16, 20, 24):
            sc = ru32(gp, off)
            if 0 < sc < 1000:
                set_count = sc
                break
        else:
            set_count = 0
        print(f"Group[{gi}] {grp_name!r} sets={set_count}")
        sys.stdout.flush()
    except Exception as e:
        print(f"Group[{gi}] params error: {e}"); sys.stdout.flush(); continue

    try:
        GetMS = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32)(g_vt[2])
    except Exception as e:
        print(f"  GetMS vtable error: {e}"); sys.stdout.flush(); continue

    for si in range(min(set_count, 100)):
        try:
            ms = GetMS(grp, si)
            if not ms: continue
            ms_vt = vt(ms)
            GetMSP = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p)(ms_vt[1])
            msp = GetMSP(ms)
            if not msp: continue
            ms_name = rstr(rptr(msp, 0))
            metric_count = ru32(msp, 20)
            if metric_count > 500: metric_count = 0  # sanity cap
        except Exception as e:
            print(f"  Set[{si}] error: {e}"); sys.stdout.flush(); continue

        try:
            GetMet = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32)(ms_vt[2])
            hits = []
            for mi in range(min(metric_count, 300)):
                try:
                    m = GetMet(ms, mi)
                    if not m: continue
                    m_vt = vt(m)
                    GetMP = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p)(m_vt[1])
                    mp = GetMP(m)
                    if not mp: continue
                    m_name = rstr(rptr(mp, 0))
                    if any(k in m_name.lower() for k in ['power','energy','watt','temp','thermal']):
                        hits.append((mi, m_name))
                except Exception:
                    continue
        except Exception as e:
            hits = []

        if hits:
            print(f"  Set[{si}] {ms_name!r} metrics={metric_count}")
            for mi, mn in hits:
                print(f"    *** Metric[{mi}] {mn!r}")
                power_hits.append((gi, grp_name, si, ms_name, mi, mn))
        else:
            print(f"  Set[{si}] {ms_name!r}")
        sys.stdout.flush()

print("\n=== POWER/ENERGY METRICS FOUND ===")
for h in power_hits:
    print(h)
