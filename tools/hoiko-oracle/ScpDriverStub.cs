// ScpDriverInterface.dll replacement (a MANAGED assembly). Serves two purposes:
//  1) no-op stubs so Hoiko.exe's C++ module initializer no longer throws
//     "SCP Virtual Bus Device not found", allowing the mixed-mode main module to load;
//  2) an oracle worker that reflects Hoiko's global <Module> search methods and runs
//     SearchAI.Search on a synthetic position, dumping results to console + a file.
//
// C#5-compatible (Wine .NET Framework csc-compatible).

using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace ScpDriverInterface
{
    public enum X360Buttons
    {
        None = 0, Up = 1, Down = 2, Left = 4, Right = 8, Start = 0x10, Back = 0x20,
        LeftStick = 0x40, RightStick = 0x80, LeftBumper = 0x100, RightBumper = 0x200,
        Logo = 0x400, A = 0x1000, B = 0x2000, X = 0x4000, Y = 0x8000
    }

    public sealed class ScpBus : IDisposable
    {
        public ScpBus() { OracleHost.Kickoff(); }
        public ScpBus(int instance) { OracleHost.Kickoff(); }
        public ScpBus(string devicePath) { OracleHost.Kickoff(); }
        public void Close() { }
        public void Dispose() { }
        private void Dispose(bool disposing) { }
        public bool PlugIn(int controllerNumber) { return true; }
        public bool Unplug(int controllerNumber) { return true; }
        public bool UnplugAll() { return true; }
        public bool Report(int controllerNumber, byte[] controllerReport) { return true; }
        public bool Report(int controllerNumber, byte[] controllerReport, byte[] outputBuffer) { return true; }
    }

    public sealed class X360Controller
    {
        public X360Controller() { }
        public X360Controller(X360Buttons buttons, byte leftTrigger, byte rightTrigger,
            short leftStickX, short leftStickY, short rightStickX, short rightStickY)
        {
            Buttons = buttons; LeftTrigger = leftTrigger; RightTrigger = rightTrigger;
            LeftStickX = leftStickX; LeftStickY = leftStickY;
            RightStickX = rightStickX; RightStickY = rightStickY;
        }
        public X360Controller(X360Controller controller)
        {
            if (controller != null)
            {
                Buttons = controller.Buttons; LeftTrigger = controller.LeftTrigger;
                RightTrigger = controller.RightTrigger; LeftStickX = controller.LeftStickX;
                LeftStickY = controller.LeftStickY; RightStickX = controller.RightStickX;
                RightStickY = controller.RightStickY;
            }
        }
        public X360Buttons Buttons { get; set; }
        public byte LeftTrigger { get; set; }
        public byte RightTrigger { get; set; }
        public short LeftStickX { get; set; }
        public short LeftStickY { get; set; }
        public short RightStickX { get; set; }
        public short RightStickY { get; set; }
        public byte[] GetReport() { return new byte[0x1c]; }
    }
}

internal static class OracleHost
{
    private const int RootBufSize = 8192;
    // RootNode layout (SPEC_Search §1.3/§1.4): next@0, game@120; game fields:
    // hold@+16, fallingMino@+32, board@+96, combo@+288, btb@+292, act@+296.
    private const int OffHold = 136;
    private const int OffFalling = 152;
    private const int OffBoard = 216;
    private const int OffMoveDelay = 400;
    private const int OffCombo = 408;
    private const int OffBtb = 412;
    private const int OffAct = 416;
    private const int OffElapsed = 432;
    private const int OffNodeCount = 440;
    private const int OffDepth = 444;
    private const int OffClear = 448;
    private const int OffBeam = 452;
    private const int OffFirstMove = 456;
    private const int OffFirstMoveSrs = 472;
    private const int OffMoveSeq = 468;

    private static int _started;
    private static bool _initDone;
    private static bool _startTimer;
    private static bool _twoSearch;
    private static int _offsetMode;
    // Hold slot mino (opt-in via `hold=`): default 7 == MinoType.NONE, which is
    // exactly what HoldMino.Init writes, so omitting the key is behavior-preserving.
    private static int _hold = 7;
    // Carried `Others` state (opt-in via `combo=` / `b2b=`), default 0 like Others.Init.
    private static int _combo;
    private static int _btb;
    private static FieldInfo _isEvenBoardField;
    private static bool _fieldScanDone;
    private static string _logPath;
    private static StreamWriter _file;

    public static void Kickoff()
    {
        if (Interlocked.Exchange(ref _started, 1) != 0) return;
        Thread t = new Thread(Worker);
        t.IsBackground = true;
        t.Start();
    }

    private static void Worker()
    {
        Exception last = null;
        for (int attempt = 0; attempt < 40; attempt++)
        {
            try
            {
                if (RunOnce()) { Log("ORACLE_OK"); Flush(); Environment.Exit(0); }
            }
            catch (Exception e) { last = e; }
            Flush();
            Thread.Sleep(250);
        }
        Log("ORACLE_FAIL after retries: " + Describe(last));
        Flush();
        Environment.Exit(1);
    }

    private static bool RunOnce()
    {
        Assembly asm = Assembly.GetEntryAssembly();
        if (asm == null) { Log("[wait] no entry assembly yet"); return false; }
        _asm = asm;

        MethodInfo miConfigRead = Resolve(0x0600012d, "ConfigAI.ReadConfig", 0);
        MethodInfo miSearchInit = Resolve(0x06000208, "SearchAI.Init", 0);
        MethodInfo miSearchReadConfig = Resolve(0x0600020a, "SearchAI.ReadConfig", 0);
        MethodInfo miRootInit = Resolve(0x0600011f, "RootNode.Init", 2);
        MethodInfo miUpdateMaxHeight = Resolve(0x0600025a, "Board.UpdateMaxHeight", 1);
        MethodInfo miSearch = Resolve(0x0600020e, "SearchAI.Search", 1);
        MethodInfo miIsSearching = Resolve(0x0600020d, "SearchAI.IsSearching", 1);
        MethodInfo miGetDelay = Resolve(0x06000126, "RootNode.GetDelay", 1);
        if (miRootInit == null || miSearch == null)
        {
            Log("[wait] search methods not visible yet (entry=" + asm.GetName().Name + ")");
            return false;
        }

        if (!_initDone)
        {
            Log("[1] ConfigAI.ReadConfig"); Invoke(miConfigRead);
            Log("[2] SearchAI.Init"); Invoke(miSearchInit);
            Log("[3] SearchAI.ReadConfig"); Invoke(miSearchReadConfig);
            _initDone = true;
        }

        int[] seq = new int[] { 0,1,2,3,4,5,6, 0,1,2,3,4,5,6, 0,1,2,3,4,5,6, 0,1,2,3,4,5,6 };
        int[] board = new int[32];
        board[0] = 0x1FF;
        board[1] = 0x001;
        board[2] = 0x001;
        board[3] = 0x001;
        LoadInput(ref seq, board);

        IntPtr buf = Marshal.AllocHGlobal(RootBufSize);
        for (int i = 0; i < RootBufSize; i += 8) Marshal.WriteInt64(buf, i, 0L);
        IntPtr nx = Marshal.AllocHGlobal(28 * 4);
        for (int i = 0; i < 28; i++) Marshal.WriteInt32(nx, i * 4, seq[i % seq.Length]);

        Log("[4] RootNode.Init(root, nextSeq)");
        Invoke(miRootInit, buf, nx);
        for (int r = 0; r < 32; r++)
        {
            if (board[r] == 0) continue;
            Marshal.WriteInt32(buf, OffBoard + r * 4, board[r]);
            Log("     board row " + r + " mask=0x" + board[r].ToString("x3", CultureInfo.InvariantCulture));
        }
        Invoke(miUpdateMaxHeight, new IntPtr(buf.ToInt64() + OffBoard));
        Marshal.WriteInt32(buf, OffHold, _hold);
        Marshal.WriteInt32(buf, OffCombo, _combo);
        Marshal.WriteInt32(buf, OffBtb, _btb);
        Log("  input hold @136 = " + _hold + ", combo @408 = " + _combo + ", btb @412 = " + _btb);
        Log("  board.stackHeight @344 = " + Marshal.ReadInt32(buf, 344));
        Log("  fallingMino @152: x=" + Marshal.ReadInt32(buf, 152) + " y=" + Marshal.ReadInt32(buf, 156) + " r=" + Marshal.ReadInt32(buf, 160) + " m=" + Marshal.ReadInt32(buf, 164));

        DateTime t0 = DateTime.UtcNow;
        Log("[5] SearchAI.Search(root)");
        if (_startTimer && miIsSearching != null)
        {
            Log("[4d] SearchAI.IsSearching(true)  (starts timer, limit=1000ms)");
            Invoke(miIsSearching, true);
        }
        Invoke(miSearch, buf);
        Log("[5] returned in " + (DateTime.UtcNow - t0).TotalMilliseconds.ToString("0.0", CultureInfo.InvariantCulture) + " ms");

        Log("");
        Log("================ SEARCH RESULT ================");
        Log("  nodeCount  @440 = " + Marshal.ReadInt32(buf, OffNodeCount));
        Log("  depth      @444 = " + Marshal.ReadInt32(buf, OffDepth));
        Log("  clear/score@448 = " + Marshal.ReadInt32(buf, OffClear));
        Log("  beamLimit  @452 = " + Marshal.ReadInt32(buf, OffBeam));
        Log("  elapsed    @432 = " + BitConverter.Int64BitsToDouble(Marshal.ReadInt64(buf, OffElapsed)).ToString("0.000", CultureInfo.InvariantCulture));
        if (miGetDelay != null) Log("  GetDelay        = " + Convert.ToString(Invoke(miGetDelay, buf), CultureInfo.InvariantCulture));
        Log("  moveDelay @400  = " + Marshal.ReadInt32(buf, OffMoveDelay));
        Log("  act       @416  = " + Marshal.ReadInt32(buf, OffAct));
        Log("  firstMoveSrs @472 = " + Marshal.ReadInt32(buf, OffFirstMoveSrs));
        Log("  root GamePack board @216 row0 = 0x" + Marshal.ReadInt32(buf, 216).ToString("x3", CultureInfo.InvariantCulture));

        Log("");
        Log("---------- POST-MOVE ROOT STATE (WriteResult gen-1) ----------");
        Log("postmove: hold=" + Marshal.ReadInt32(buf, OffHold)
            + " combo=" + Marshal.ReadInt32(buf, OffCombo)
            + " btb=" + Marshal.ReadInt32(buf, OffBtb)
            + " act=" + Marshal.ReadInt32(buf, OffAct)
            + " moveDelay=" + Marshal.ReadInt32(buf, OffMoveDelay)
            + " fallX=" + Marshal.ReadInt32(buf, OffFalling)
            + " fallY=" + Marshal.ReadInt32(buf, OffFalling + 4)
            + " fallRot=" + Marshal.ReadInt32(buf, OffFalling + 8)
            + " fallM=" + Marshal.ReadInt32(buf, OffFalling + 12));

        Log("");
        Log("-------------- CHOSEN MOVE (decoded) --------------");
        DumpFallMino("firstMove @456", buf, OffFirstMove);
        for (int i = 0; i < 14; i++)
        {
            int off = OffMoveSeq + i * 32;
            if (Marshal.ReadInt32(buf, off) == 7 && i > 0) { Log("      seq[" + i + "] sentinel(7) - end"); break; }
            DumpFallMino("seq[" + i + "] @" + off, buf, off);
        }

        Log("");
        Log("-------------- RAW HEX --------------");
        Log("best GamePack @120..424: " + Hex(buf, 120, 304));
        Log("result region @432..960: " + Hex(buf, 432, 528));
        Log("final board  @216..344: " + Hex(buf, OffBoard, 128));

        if (_twoSearch && miSearch != null)
        {
            Log("");
            Log("[6] SECOND SEARCH (reads global beamSizeLimit adapted by search 1's SetNextOption)");
            IntPtr buf2 = Marshal.AllocHGlobal(RootBufSize);
            for (int i = 0; i < RootBufSize; i += 8) Marshal.WriteInt64(buf2, i, 0L);
            IntPtr nx2 = Marshal.AllocHGlobal(28 * 4);
            for (int i = 0; i < 28; i++) Marshal.WriteInt32(nx2, i * 4, seq[i % seq.Length]);
            Invoke(miRootInit, buf2, nx2);
            for (int r = 0; r < 32; r++)
            {
                if (board[r] != 0) Marshal.WriteInt32(buf2, OffBoard + r * 4, board[r]);
            }
            Invoke(miUpdateMaxHeight, new IntPtr(buf2.ToInt64() + OffBoard));
            Marshal.WriteInt32(buf2, OffHold, _hold);
            Marshal.WriteInt32(buf2, OffCombo, _combo);
            Marshal.WriteInt32(buf2, OffBtb, _btb);
            Invoke(miSearch, buf2);
            Log("  search2 depth @444     = " + Marshal.ReadInt32(buf2, OffDepth));
            Log("  search2 beamLimit @452 = " + Marshal.ReadInt32(buf2, OffBeam));
            if (miGetDelay != null) Log("  search2 GetDelay       = " + Convert.ToString(Invoke(miGetDelay, buf2), CultureInfo.InvariantCulture));
            Marshal.FreeHGlobal(buf2);
            Marshal.FreeHGlobal(nx2);
        }

        if (_offsetMode != 0)
        {
            IntPtr offBuf = Marshal.AllocHGlobal(RootBufSize);
            for (int i = 0; i < RootBufSize; i += 8) Marshal.WriteInt64(offBuf, i, 0L);
            try { RunOffsetProbes(offBuf, miUpdateMaxHeight); }
            catch (Exception e) { Log("[offset] RunOffsetProbes threw: " + Describe(e)); }
            Marshal.FreeHGlobal(offBuf);
        }

        Marshal.FreeHGlobal(buf);
        Marshal.FreeHGlobal(nx);
        return true;
    }

    private static Assembly _asm;

    private static MethodInfo Resolve(int token, string name, int argc)
    {
        try
        {
            MethodInfo mi = (MethodInfo)_asm.ManifestModule.ResolveMethod(token);
            if (mi != null)
            {
                Log("[resolve] token 0x" + token.ToString("x8") + " -> " + name + " OK");
                return mi;
            }
        }
        catch (Exception e)
        {
            Log("[resolve] token 0x" + token.ToString("x8") + " (" + name + ") FAILED: " + e.GetType().Name + ": " + e.Message);
        }
        Type mod = null;
        try { mod = _asm.GetType("<Module>", false); } catch { }
        if (mod == null)
        {
            Type[] ts; try { ts = _asm.GetTypes(); } catch (ReflectionTypeLoadException e) { ts = e.Types; }
            for (int i = 0; i < ts.Length && mod == null; i++)
                if (ts[i] != null && ts[i].Name == "<Module>") mod = ts[i];
        }
        return mod == null ? null : Find(mod, name, argc);
    }

    private static void LoadInput(ref int[] seq, int[] board)
    {
        string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "oracle_input.txt");
        if (!File.Exists(path)) { Log("[input] oracle_input.txt not found - using built-in synthetic position"); return; }
        foreach (string raw in File.ReadAllLines(path))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("#") || line.StartsWith("//")) continue;
            int eq = line.IndexOf('=');
            if (eq <= 0) continue;
            string key = line.Substring(0, eq).Trim().ToLowerInvariant();
            string val = line.Substring(eq + 1).Trim();
            string[] parts = val.Split(',');
            if (key == "next")
            {
                int[] s = new int[parts.Length];
                for (int i = 0; i < parts.Length; i++) s[i] = int.Parse(parts[i].Trim(), CultureInfo.InvariantCulture);
                if (s.Length > 0) seq = s;
            }
            else if (key == "board")
            {
                for (int i = 0; i < parts.Length && i < 32; i++)
                    board[i] = (int)long.Parse(parts[i].Trim().Replace("0x", ""), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            }
            else if (key == "timer")
            {
                _startTimer = val != "0";
            }
            else if (key == "twosearch")
            {
                _twoSearch = val != "0";
            }
            else if (key == "offset")
            {
                _offsetMode = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "hold")
            {
                _hold = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "combo")
            {
                _combo = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "b2b" || key == "btb")
            {
                _btb = int.Parse(val, CultureInfo.InvariantCulture);
            }
        }
        Log("[input] loaded oracle_input.txt (board rows=" + board.Length + ", next=" + seq.Length + ")");
    }

    private static MethodInfo Find(Type mod, string name, int argc)
    {
        MethodInfo[] ms = mod.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        for (int i = 0; i < ms.Length; i++)
            if (ms[i].Name == name && ms[i].GetParameters().Length == argc) return ms[i];
        return null;
    }

    private static object Invoke(MethodInfo m, params object[] args)
    {
        if (m == null) throw new InvalidOperationException("null method");
        ParameterInfo[] ps = m.GetParameters();
        object[] coerced = new object[args.Length];
        for (int i = 0; i < args.Length; i++)
        {
            object a = args[i];
            if (i < ps.Length && ps[i].ParameterType.IsEnum && a is int) a = Enum.ToObject(ps[i].ParameterType, a);
            coerced[i] = a;
        }
        try { return m.Invoke(null, coerced); }
        catch (TargetInvocationException e)
        {
            Exception inner = e.InnerException != null ? e.InnerException : e;
            throw new Exception("Invoke [" + m.Name + "] -> " + inner.GetType().FullName + ": " + inner.Message
                + " | stack: " + inner.StackTrace, inner);
        }
    }

    private static void SetBoard(IntPtr root, int c4)
    {
        for (int i = 0; i < 32; i++) Marshal.WriteInt32(root, OffBoard + i * 4, 0);
        int mask = (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6);
        for (int y = 0; y < c4 && y < 32; y++) Marshal.WriteInt32(root, OffBoard + y * 4, mask);
        Invoke(_miUpdateMaxHeight, new IntPtr(root.ToInt64() + OffBoard));
    }

    private static MethodInfo _miUpdateMaxHeight;

    private static void SetEvenBoard(bool v)
    {
        if (!_fieldScanDone)
        {
            _fieldScanDone = true;
            try
            {
                _isEvenBoardField = _asm.ManifestModule.ResolveField(0x0400012f);
                if (_isEvenBoardField != null)
                    Log("[offset] isEvenBoard field = " + _isEvenBoardField.Name + " token=0x" + _isEvenBoardField.MetadataToken.ToString("x8"));
            }
            catch (Exception e) { Log("[offset] field scan error: " + e.GetType().Name + ": " + e.Message); }
            if (_isEvenBoardField == null) Log("[offset] WARNING isEvenBoard field not found");
        }
        if (_isEvenBoardField != null) _isEvenBoardField.SetValue(null, v);
    }

    private static void LogOffsetState(string tag)
    {
        DumpStaticStruct(tag, "ofsData", 0x04000139);
        DumpStaticStruct(tag, "gbData", 0x04000137);
    }

    private static void DumpStaticStruct(string tag, string namePart, int fieldToken)
    {
        try
        {
            FieldInfo fi = _asm.ManifestModule.ResolveField(fieldToken);
            object v = fi.GetValue(null);
            if (v == null) return;
            FieldInfo[] inner = v.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            StringBuilder sb = new StringBuilder("[ofs] " + tag + " " + namePart + " {");
            for (int j = 0; j < inner.Length; j++)
                sb.Append(" ").Append(inner[j].Name).Append("=").Append(Convert.ToString(inner[j].GetValue(v), CultureInfo.InvariantCulture));
            sb.Append(" }");
            Log(sb.ToString());
        }
        catch (Exception e) { Log("[ofs] " + tag + " dump error: " + e.GetType().Name + ": " + e.Message); }
    }

    private static void RunOffsetProbes(IntPtr root, MethodInfo miUpdateMaxHeight)
    {
        _miUpdateMaxHeight = miUpdateMaxHeight;
        // Global (mixed-mode <Module>) methods are not enumerable via reflection;
        // resolve them by their verified metadata tokens (RID from monodis --method).
        Log("[gfind] manifest global methods = " + _asm.ManifestModule.GetMethods().Length + " (tokens used instead)");

        MethodInfo useOff = Resolve(0x060001d5, "OffsetOffAI.UseOffsetOff", 1);
        MethodInfo canOff = Resolve(0x060001d7, "OffsetOffAI.CanOffsetOff", 1);
        MethodInfo decOff = Resolve(0x060001d8, "OffsetOffAI.DecisionOffsetOff", 1);
        MethodInfo resetAtk = Resolve(0x060001d9, "OffsetOffAI.ResetOpponentsAtk", 0);
        MethodInfo calcAtk = Resolve(0x060001da, "OffsetOffAI.CalcOpponentsAtk", 4);
        MethodInfo getAtk = Resolve(0x060001db, "OffsetOffAI.GetOpponentsAtk", 0);
        MethodInfo setPrev = Resolve(0x060001dc, "OffsetOffAI.SetPrevAct", 1);
        MethodInfo lockOff = Resolve(0x060001dd, "OffsetOffAI.LockOffsetAfterClearing", 3);
        MethodInfo oppNew = Resolve(0x060001de, "OffsetOffAI.OpponentIsNewLockDown", 1);
        MethodInfo invAtk = Resolve(0x060001df, "OffsetOffAI.InvalidateGettingEnemysAtk", 0);
        MethodInfo isLocked = Resolve(0x060001e0, "OffsetOffAI.IsLocked", 1);
        MethodInfo firstInvalid = Resolve(0x060001e1, "OffsetOffAI.IsFirstInvalidLockDown", 0);

        Log("");
        Log("=============== OFFSET PROBES ===============");
        Log("[methods] useOff=" + (useOff != null) + " canOff=" + (canOff != null) + " decOff=" + (decOff != null)
            + " calcAtk=" + (calcAtk != null) + " getAtk=" + (getAtk != null) + " resetAtk=" + (resetAtk != null)
            + " invAtk=" + (invAtk != null) + " setPrev=" + (setPrev != null) + " lockOff=" + (lockOff != null)
            + " oppNew=" + (oppNew != null) + " isLocked=" + (isLocked != null) + " firstInvalid=" + (firstInvalid != null));

        if (useOff == null || canOff == null) { Log("[offset] core methods missing"); return; }

        Invoke(useOff, true);
        StringBuilder fresh = new StringBuilder("canWaitFresh");
        for (int g = 0; g <= 15; g++) fresh.Append(" ").Append(g).Append(":").Append((bool)Invoke(canOff, g) ? 1 : 0);
        Log(fresh.ToString());
        LogOffsetState("fresh");

        int[,] cases = new int[,] {
            {0,1,0,0},{1,1,0,0},{2,1,0,0},{3,1,0,0},{4,1,0,0},{5,1,0,0},
            {2,0,0,0},{2,1,0,2},{2,1,0,3},{3,1,1,4},{3,1,1,5},{4,1,1,2},{4,2,1,0},{2,1,1,4}
        };
        for (int i = 0; i < cases.GetLength(0); i++)
        {
            int line = cases[i, 0], btb = cases[i, 1], buff = cases[i, 2], combo = cases[i, 3];
            Invoke(resetAtk);
            Invoke(calcAtk, line, btb, buff, combo);
            Log("calcAtk " + line + "," + btb + "," + buff + "," + combo + " -> " + Invoke(getAtk));
        }
        Invoke(invAtk);
        Log("afterInvalidate getAtk -> " + Invoke(getAtk));

        for (int act = 0; act <= 9; act++)
        {
            Invoke(useOff, true);
            Invoke(setPrev, act);
            Invoke(lockOff, 1000, 0, 7);
            Log("lock act=" + act + " send=0 " + (bool)Invoke(isLocked, 1000) + " " + (bool)Invoke(isLocked, 1028) + " "
                + (bool)Invoke(isLocked, 1029) + " " + (bool)Invoke(isLocked, 1030) + " fi=" + (bool)Invoke(firstInvalid)
                + " fi2=" + (bool)Invoke(firstInvalid));
            Invoke(useOff, true);
            Invoke(setPrev, act);
            Invoke(lockOff, 1000, 1, 9);
            Log("lock act=" + act + " send=1 " + (bool)Invoke(isLocked, 1000) + " " + (bool)Invoke(isLocked, 1024)
                + " " + (bool)Invoke(isLocked, 1025));
        }
        Invoke(useOff, true);
        Invoke(lockOff, 1000, 0, 3);
        Log("lockNone isLocked(2000)=" + (bool)Invoke(isLocked, 2000));

        Invoke(useOff, true);
        Log("oppNew " + (bool)Invoke(oppNew, 5) + " " + (bool)Invoke(oppNew, 5) + " " + (bool)Invoke(oppNew, 6));

        if (decOff == null) { Log("[offset] DecisionOffsetOff missing"); return; }
        string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "offset_cases.txt");
        if (!File.Exists(path)) { Log("[offset] offset_cases.txt not found"); return; }
        foreach (string raw in File.ReadAllLines(path))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("#")) continue;
            string[] p = line.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            if (p.Length < 9) continue;
            int act1 = int.Parse(p[0], CultureInfo.InvariantCulture);
            int act2 = int.Parse(p[1], CultureInfo.InvariantCulture);
            int act3 = int.Parse(p[2], CultureInfo.InvariantCulture);
            int hold = int.Parse(p[3], CultureInfo.InvariantCulture);
            int next2 = int.Parse(p[4], CultureInfo.InvariantCulture);
            int btb = int.Parse(p[5], CultureInfo.InvariantCulture);
            int depth = int.Parse(p[6], CultureInfo.InvariantCulture);
            int trustEnd = int.Parse(p[7], CultureInfo.InvariantCulture);
            int c4 = int.Parse(p[8], CultureInfo.InvariantCulture);
            int even = p.Length > 9 ? int.Parse(p[9], CultureInfo.InvariantCulture) : 0;

            SetEvenBoard(even != 0);
            SetBoard(root, c4);
            Marshal.WriteInt32(root, 136, hold);
            Marshal.WriteInt32(root, 8, next2);
            Marshal.WriteInt32(root, 412, btb);
            Marshal.WriteInt32(root, 444, depth);
            Marshal.WriteInt32(root, 112, trustEnd);
            for (int i = 0; i < 14; i++) Marshal.WriteInt32(root, 904 + i * 4, 0);
            Marshal.WriteInt32(root, 904, 0);
            Marshal.WriteInt32(root, 908, act1);
            Marshal.WriteInt32(root, 912, act2);
            Marshal.WriteInt32(root, 916, act3);

            Invoke(useOff, true);
            Invoke(decOff, root);
            LogOffsetState("dec");
            StringBuilder sb = new StringBuilder("decision");
            sb.Append(" a1=").Append(act1).Append(" a2=").Append(act2).Append(" a3=").Append(act3)
              .Append(" hold=").Append(hold).Append(" n2=").Append(next2).Append(" btb=").Append(btb)
              .Append(" d=").Append(depth).Append(" te=").Append(trustEnd).Append(" c4=").Append(c4).Append(" even=").Append(even).Append(" g=");
            for (int g = 0; g <= 15; g++) sb.Append((bool)Invoke(canOff, g) ? 1 : 0);
            Log(sb.ToString());
        }
    }

    private static void DumpFallMino(string label, IntPtr p, int off)
    {
        Log("  " + label + ": x=" + Marshal.ReadInt32(p, off)
            + " y=" + Marshal.ReadInt32(p, off + 4)
            + " rot=" + Marshal.ReadInt32(p, off + 8)
            + " m=" + Marshal.ReadInt32(p, off + 12)
            + "  raw " + Hex(p, off, 32));
    }

    private static string Hex(IntPtr p, int off, int len)
    {
        byte[] b = new byte[len];
        Marshal.Copy(new IntPtr(p.ToInt64() + off), b, 0, len);
        StringBuilder sb = new StringBuilder(len * 3);
        for (int i = 0; i < len; i++) sb.Append(b[i].ToString("x2", CultureInfo.InvariantCulture)).Append(' ');
        return sb.ToString();
    }

    private static string Describe(Exception e)
    {
        if (e == null) return "<none>";
        string s = e.GetType().FullName + ": " + e.Message;
        Exception c = e.InnerException; int d = 0;
        while (c != null && d < 5) { s += " | inner: " + c.GetType().Name + ": " + c.Message; c = c.InnerException; d++; }
        return s;
    }

    private static void Log(string s)
    {
        try { Console.WriteLine(s); } catch { }
        try
        {
            if (_file == null)
            {
                _logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "oracle_result.txt");
                _file = new StreamWriter(_logPath, false, Encoding.UTF8);
                _file.AutoFlush = true;
            }
            _file.WriteLine(s);
        }
        catch { }
    }

    private static void Flush()
    {
        try { Console.Out.Flush(); } catch { }
        try { if (_file != null) { _file.Flush(); _file.Close(); _file = null; } } catch { }
    }
}
