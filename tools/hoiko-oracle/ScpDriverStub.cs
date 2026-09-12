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
    // SearchResult.plans.mino[i] starts at RootNode+456+32*i (SPEC_Search §1.6);
    // mino[i].m is at +468+32*i. The old 468 base misaligned the seq[] dump by 12.
    private const int OffMoveSeq = 456;
    private const int OffPlanAct = 904;

    private static int _started;
    private static bool _initDone;
    private static bool _startTimer;
    private static bool _twoSearch;
    private static int _offsetMode;
    // Expand-probe mode (`expand=1`): call ExpandAI.ExpandNode directly on the
    // root, then follow `path=x:rot:m,...` through the chosen children.
    private static int _expandMode;
    private static string _expandPath = "";
    // Eval-probe mode (`eval=1`): walk `path=` through ExpandAI.ExpandNode and
    // call EvaluateAI.EvaluateFirst / EvaluateAI.Evaluate on every child,
    // dumping the returned score/familyScore and every accessible sub-term.
    private static int _evalMode;
    // Batch expand mode (`expand_multi=1`): expand every `board|next|hold|combo|b2b`
    // line of `positions_file` (default expand_positions.txt) in one process.
    private static int _expandMulti;
    private static string _expandMultiFile = "expand_positions.txt";
    // Optional falling-piece spawn height (`fally=`), written after the board so
    // the searched state matches the replica's `build_root` spawn. -1 = leave it.
    private static int _fallY = -1;
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
        if (_fallY >= 0) Marshal.WriteInt32(buf, OffFalling + 4, _fallY);
        Marshal.WriteInt32(buf, OffHold, _hold);
        Marshal.WriteInt32(buf, OffCombo, _combo);
        Marshal.WriteInt32(buf, OffBtb, _btb);
        Log("  input hold @136 = " + _hold + ", combo @408 = " + _combo + ", btb @412 = " + _btb);
        Log("  board.stackHeight @344 = " + Marshal.ReadInt32(buf, 344));
        Log("  fallingMino @152: x=" + Marshal.ReadInt32(buf, 152) + " y=" + Marshal.ReadInt32(buf, 156) + " r=" + Marshal.ReadInt32(buf, 160) + " m=" + Marshal.ReadInt32(buf, 164));

        if (_expandMode != 0)
        {
            Log("[5] expand probe (SearchAI.Search skipped)");
            RunExpandProbes(buf);
            Marshal.FreeHGlobal(buf);
            Marshal.FreeHGlobal(nx);
            return true;
        }

        if (_expandMulti != 0)
        {
            Log("[5] batch expand probe (SearchAI.Search skipped)");
            RunExpandMulti(miRootInit, miUpdateMaxHeight);
            Marshal.FreeHGlobal(buf);
            Marshal.FreeHGlobal(nx);
            return true;
        }

        if (_evalMode != 0)
        {
            Log("[5] eval probe (SearchAI.Search skipped)");
            RunEvalProbe(buf);
            Marshal.FreeHGlobal(buf);
            Marshal.FreeHGlobal(nx);
            return true;
        }

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
        int planDepth = Marshal.ReadInt32(buf, OffDepth);
        if (planDepth < 0) planDepth = 0;
        if (planDepth > 14) planDepth = 14;
        for (int i = 0; i < planDepth; i++)
        {
            int off = OffMoveSeq + i * 32;
            int m = Marshal.ReadInt32(buf, off + 12);
            int srs = Marshal.ReadInt32(buf, off + 16);
            if (m == 7 && srs == 8)
            {
                Log("  seq[" + i + "] @" + off + ": drawingBreak (m=None lastSrs=8) raw " + Hex(buf, off, 32));
                continue;
            }
            Log("  seq[" + i + "] @" + off + ": x=" + Marshal.ReadInt32(buf, off)
                + " y=" + Marshal.ReadInt32(buf, off + 4)
                + " rot=" + Marshal.ReadInt32(buf, off + 8)
                + " m=" + m
                + " act=" + Marshal.ReadInt32(buf, OffPlanAct + i * 4)
                + " raw " + Hex(buf, off, 32));
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
            else if (key == "expand")
            {
                _expandMode = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "eval")
            {
                _evalMode = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "path")
            {
                _expandPath = val;
            }
            else if (key == "expand_multi")
            {
                _expandMulti = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "positions_file")
            {
                _expandMultiFile = val;
            }
            else if (key == "fally")
            {
                _fallY = int.Parse(val, CultureInfo.InvariantCulture);
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
    {        _miUpdateMaxHeight = miUpdateMaxHeight;
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

    private const int NodeStride = 328;
    private const int NodeCap = 300;

    private static int[][] ParseExpandPath()
    {
        if (_expandPath.Length == 0) return new int[0][];
        string[] items = _expandPath.Split(',');
        int[][] path = new int[items.Length][];
        for (int i = 0; i < items.Length; i++)
        {
            string[] p = items[i].Split(':');
            if (p.Length < 3) { Log("[expand] bad path item: " + items[i]); return new int[0][]; }
            path[i] = new int[] {
                int.Parse(p[0].Trim(), CultureInfo.InvariantCulture),
                int.Parse(p[1].Trim(), CultureInfo.InvariantCulture),
                int.Parse(p[2].Trim(), CultureInfo.InvariantCulture),
                p.Length > 3 ? int.Parse(p[3].Trim(), CultureInfo.InvariantCulture) : -1,
            };
        }
        return path;
    }

    private static void RunExpandProbes(IntPtr root)
    {
        MethodInfo miExpand = Resolve(0x060001ea, "ExpandAI.ExpandNode", 3);
        if (miExpand == null) { Log("[expand] ExpandAI.ExpandNode missing"); return; }

        int[][] path = ParseExpandPath();
        int bufSize = NodeStride * NodeCap;
        IntPtr bufA = Marshal.AllocHGlobal(bufSize);
        IntPtr bufB = Marshal.AllocHGlobal(bufSize);
        IntPtr countPtr = Marshal.AllocHGlobal(4);

        Log("");
        Log("=============== EXPAND PROBES ===============");
        Log("[expand] generations=" + (path.Length + 1));

        IntPtr game = new IntPtr(root.ToInt64() + 120);
        int gens = path.Length + 1;
        for (int k = 0; k < gens; k++)
        {
            IntPtr outBuf = (k % 2 == 0) ? bufA : bufB;
            Marshal.WriteInt32(countPtr, 0);
            Invoke(miExpand, game, outBuf, countPtr);
            int count = Marshal.ReadInt32(countPtr);
            if (count < 0) count = 0;
            if (count > NodeCap) count = NodeCap;
            int safe = (Marshal.ReadInt32(game, 224) < Marshal.ReadInt32(game, 36) - 3) ? 1 : 0;
            Log("GEN " + k + " count=" + count + " safe=" + safe
                + " curM=" + Marshal.ReadInt32(game, 44)
                + " holdM=" + Marshal.ReadInt32(game, 16)
                + " combo=" + Marshal.ReadInt32(game, 288)
                + " btb=" + Marshal.ReadInt32(game, 292));
            for (int i = 0; i < count; i++)
            {
                IntPtr child = new IntPtr(outBuf.ToInt64() + i * NodeStride);
                DumpExpandChild(k, i, child, root);
            }
            if (k >= path.Length) break;
            int sel = -1;
            int matches = 0;
            for (int i = 0; i < count; i++)
            {
                IntPtr child = new IntPtr(outBuf.ToInt64() + i * NodeStride);
                if (Marshal.ReadInt32(child, 64) == path[k][0]
                    && (Marshal.ReadInt32(child, 72) & 3) == path[k][1]
                    && (path[k][2] < 0 || Marshal.ReadInt32(child, 76) == path[k][2])
                    && (path[k][3] < 0 || Marshal.ReadInt32(child, 296) == path[k][3]))
                {
                    if (sel < 0) sel = i;
                    matches++;
                }
            }
            if (sel < 0)
            {
                Log("PATH " + k + " NOT_FOUND x=" + path[k][0] + " rot=" + path[k][1] + " m=" + path[k][2]);
                break;
            }
            Log("PATH " + k + " sel=" + sel + " matches=" + matches
                + " x=" + path[k][0] + " rot=" + path[k][1] + " m=" + path[k][2]);
            game = new IntPtr(outBuf.ToInt64() + sel * NodeStride);
        }
        Marshal.FreeHGlobal(countPtr);
        Marshal.FreeHGlobal(bufA);
        Marshal.FreeHGlobal(bufB);
    }

    private static void RunExpandMulti(MethodInfo miRootInit, MethodInfo miUpdateMaxHeight)
    {
        MethodInfo miExpand = Resolve(0x060001ea, "ExpandAI.ExpandNode", 3);
        if (miExpand == null) { Log("[expand-multi] ExpandAI.ExpandNode missing"); return; }

        string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, _expandMultiFile);
        if (!File.Exists(path)) { Log("[expand-multi] positions file not found: " + path); return; }

        IntPtr root = Marshal.AllocHGlobal(RootBufSize);
        IntPtr nx = Marshal.AllocHGlobal(28 * 4);
        IntPtr outBuf = Marshal.AllocHGlobal(NodeStride * NodeCap);
        IntPtr countPtr = Marshal.AllocHGlobal(4);

        Log("");
        Log("=============== EXPAND MULTI ===============");
        int pos = 0;
        foreach (string raw in File.ReadAllLines(path))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("#")) continue;

            int[] board = new int[32];
            int[] seq = new int[28];
            for (int i = 0; i < 28; i++) seq[i] = 7;
            int hold = _hold;
            int combo = _combo;
            int btb = _btb;
            int fallY = _fallY;
            foreach (string field in line.Split('|'))
            {
                int eq = field.IndexOf('=');
                if (eq <= 0) continue;
                string key = field.Substring(0, eq).Trim().ToLowerInvariant();
                string val = field.Substring(eq + 1).Trim();
                string[] parts = val.Split(',');
                if (key == "board")
                {
                    for (int i = 0; i < parts.Length && i < 32; i++)
                        board[i] = (int)long.Parse(parts[i].Trim().Replace("0x", ""), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                }
                else if (key == "next")
                {
                    for (int i = 0; i < parts.Length && i < 28; i++)
                        seq[i] = int.Parse(parts[i].Trim(), CultureInfo.InvariantCulture);
                }
                else if (key == "hold") hold = int.Parse(val, CultureInfo.InvariantCulture);
                else if (key == "combo") combo = int.Parse(val, CultureInfo.InvariantCulture);
                else if (key == "b2b" || key == "btb") btb = int.Parse(val, CultureInfo.InvariantCulture);
                else if (key == "fally") fallY = int.Parse(val, CultureInfo.InvariantCulture);
            }

            for (int i = 0; i < RootBufSize; i += 8) Marshal.WriteInt64(root, i, 0L);
            for (int i = 0; i < 28; i++) Marshal.WriteInt32(nx, i * 4, seq[i]);
            Invoke(miRootInit, root, nx);
            for (int r = 0; r < 32; r++) Marshal.WriteInt32(root, OffBoard + r * 4, board[r]);
            Invoke(miUpdateMaxHeight, new IntPtr(root.ToInt64() + OffBoard));
            if (fallY >= 0) Marshal.WriteInt32(root, OffFalling + 4, fallY);
            Marshal.WriteInt32(root, OffHold, hold);
            Marshal.WriteInt32(root, OffCombo, combo);
            Marshal.WriteInt32(root, OffBtb, btb);

            Marshal.WriteInt32(countPtr, 0);
            IntPtr game = new IntPtr(root.ToInt64() + 120);
            Invoke(miExpand, game, outBuf, countPtr);
            int count = Marshal.ReadInt32(countPtr);
            if (count < 0) count = 0;
            if (count > NodeCap) count = NodeCap;
            int safe = (Marshal.ReadInt32(game, 224) < Marshal.ReadInt32(game, 36) - 3) ? 1 : 0;
            Log("POS " + pos + " count=" + count + " safe=" + safe
                + " curM=" + Marshal.ReadInt32(game, 44)
                + " holdM=" + Marshal.ReadInt32(game, 16)
                + " combo=" + Marshal.ReadInt32(game, 288)
                + " btb=" + Marshal.ReadInt32(game, 292));
            for (int i = 0; i < count; i++)
            {
                IntPtr child = new IntPtr(outBuf.ToInt64() + i * NodeStride);
                DumpExpandChild(pos, i, child, root);
            }
            pos++;
        }
        Marshal.FreeHGlobal(countPtr);
        Marshal.FreeHGlobal(outBuf);
        Marshal.FreeHGlobal(nx);
        Marshal.FreeHGlobal(root);
    }

    private static void DumpExpandChild(int gen, int index, IntPtr child, IntPtr root)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("CHILD ").Append(gen).Append(' ').Append(index);
        sb.Append(" x=").Append(Marshal.ReadInt32(child, 64));
        sb.Append(" y=").Append(Marshal.ReadInt32(child, 68));
        sb.Append(" rot=").Append(Marshal.ReadInt32(child, 72));
        sb.Append(" m=").Append(Marshal.ReadInt32(child, 76));
        sb.Append(" fallM=").Append(Marshal.ReadInt32(child, 44));
        sb.Append(" holdM=").Append(Marshal.ReadInt32(child, 16));
        sb.Append(" combo=").Append(Marshal.ReadInt32(child, 288));
        sb.Append(" btb=").Append(Marshal.ReadInt32(child, 292));
        sb.Append(" act=").Append(Marshal.ReadInt32(child, 296));
        sb.Append(" delay=").Append(Marshal.ReadInt32(child, 280));
        sb.Append(" stack=").Append(Marshal.ReadInt32(child, 96 + 128));
        sb.Append(" lb=").Append(Marshal.ReadInt32(child, 96 + 132));
        sb.Append(" rows=");
        for (int r = 0; r < 32; r++)
        {
            if (r > 0) sb.Append(',');
            sb.Append(Marshal.ReadInt32(child, 96 + r * 4));
        }
        IntPtr mPtr = Marshal.ReadIntPtr(child, 0);
        long limit = root.ToInt64() + 112;
        int qn = 0;
        if (mPtr.ToInt64() >= root.ToInt64() && mPtr.ToInt64() <= limit)
            qn = (int)((limit - mPtr.ToInt64()) / 4);
        if (qn > 28) qn = 28;
        sb.Append(" queue=");
        for (int q = 0; q < qn; q++)
        {
            if (q > 0) sb.Append(',');
            sb.Append(Marshal.ReadInt32(mPtr, q * 4));
        }
        Log(sb.ToString());
    }

    private sealed class EvalMethods
    {
        public MethodInfo Eval;
        public MethodInfo EvalFirst;
        public MethodInfo ColumnHeight;
        public MethodInfo GetHeight;
        public MethodInfo GetWell;
        public MethodInfo UpDown;
        public MethodInfo Ground;
        public MethodInfo Under;
        public MethodInfo Resource;
        public MethodInfo Tsd;
        public MethodInfo Tst;
        public MethodInfo Pc;
        public MethodInfo Cont;
        public MethodInfo Action;
    }

    private static int CallInt(MethodInfo mi, params object[] args)
    {
        if (mi == null) return -999999;
        return Convert.ToInt32(Invoke(mi, args), CultureInfo.InvariantCulture);
    }

    private static void RunEvalProbe(IntPtr root)
    {
        MethodInfo miExpand = Resolve(0x060001ea, "ExpandAI.ExpandNode", 3);
        MethodInfo miTransition = Resolve(0x060001c9, "EvaluateAI.TransitionWeight", 1);
        MethodInfo miSetTrust = Resolve(0x060001ac, "EvaluateAI.SetTrustRate", 1);
        MethodInfo miViewNext = Resolve(0x0600010d, "NextMino.ViewNext", 0);
        EvalMethods em = new EvalMethods();
        em.Eval = Resolve(0x060001ad, "EvaluateAI.Evaluate", 3);
        em.EvalFirst = Resolve(0x060001ae, "EvaluateAI.EvaluateFirst", 2);
        em.ColumnHeight = Resolve(0x0600025c, "Board.GetColumnHeight", 2);
        em.GetHeight = Resolve(0x060001af, "EvaluateAI.GetHeight", 2);
        em.GetWell = Resolve(0x060001b0, "EvaluateAI.GetWellColumn", 5);
        em.UpDown = Resolve(0x060001b1, "EvaluateAI.GetUpDown", 4);
        em.Ground = Resolve(0x060001b2, "EvaluateAI.GetGround", 3);
        em.Under = Resolve(0x060001b3, "EvaluateAI.GetUnderground", 3);
        em.Resource = Resolve(0x060001b4, "EvaluateAI.GetResource", 3);
        em.Tsd = Resolve(0x060001bb, "EvaluateAI.SearchTsd", 3);
        em.Tst = Resolve(0x060001bc, "EvaluateAI.SearchTst", 4);
        em.Pc = Resolve(0x060001b6, "EvaluateAI.SearchPcBoard", 2);
        em.Cont = Resolve(0x060001c6, "EvaluateAI.GetContBonus", 1);
        em.Action = Resolve(0x060001c7, "EvaluateAI.GetFinalAction", 1);

        Log("");
        Log("=============== EVAL PROBES ===============");
        Log("[eval] expand=" + (miExpand != null) + " transition=" + (miTransition != null)
            + " setTrust=" + (miSetTrust != null) + " eval=" + (em.Eval != null)
            + " first=" + (em.EvalFirst != null) + " colH=" + (em.ColumnHeight != null)
            + " height=" + (em.GetHeight != null) + " well=" + (em.GetWell != null)
            + " updown=" + (em.UpDown != null) + " ground=" + (em.Ground != null)
            + " under=" + (em.Under != null) + " res=" + (em.Resource != null)
            + " tsd=" + (em.Tsd != null) + " tst=" + (em.Tst != null) + " pc=" + (em.Pc != null)
            + " cont=" + (em.Cont != null) + " action=" + (em.Action != null));
        if (miExpand == null || em.Eval == null || em.EvalFirst == null) return;

        int viewNext = miViewNext != null ? Convert.ToInt32(Invoke(miViewNext), CultureInfo.InvariantCulture) : -1;
        Log("[eval] NextMino.ViewNext = " + viewNext);
        Invoke(miTransition, root);
        IntPtr rootGame = new IntPtr(root.ToInt64() + 120);

        int[][] path = ParseExpandPath();
        IntPtr chPtr = Marshal.AllocHGlobal(40);
        IntPtr wcPtr = Marshal.AllocHGlobal(4);
        IntPtr wdPtr = Marshal.AllocHGlobal(4);
        IntPtr scorePtr = Marshal.AllocHGlobal(4);
        IntPtr fsPtr = Marshal.AllocHGlobal(4);
        if (_evalMode == 2)
        {
            RunEvalBfs(rootGame, miExpand, miSetTrust, viewNext, em, chPtr, wcPtr, wdPtr, scorePtr, fsPtr);
        }
        else
        {
            RunEvalWalk(rootGame, miExpand, miSetTrust, viewNext, path, em, chPtr, wcPtr, wdPtr, scorePtr, fsPtr);
        }
        Marshal.FreeHGlobal(chPtr);
        Marshal.FreeHGlobal(wcPtr);
        Marshal.FreeHGlobal(wdPtr);
        Marshal.FreeHGlobal(scorePtr);
        Marshal.FreeHGlobal(fsPtr);
    }

    private static void RunEvalWalk(IntPtr rootGame, MethodInfo miExpand, MethodInfo miSetTrust,
        int viewNext, int[][] path, EvalMethods em, IntPtr chPtr, IntPtr wcPtr, IntPtr wdPtr,
        IntPtr scorePtr, IntPtr fsPtr)
    {
        IntPtr rootNext = Marshal.ReadIntPtr(rootGame, 0);
        IntPtr bufA = Marshal.AllocHGlobal(NodeStride * NodeCap);
        IntPtr bufB = Marshal.AllocHGlobal(NodeStride * NodeCap);
        IntPtr countPtr = Marshal.AllocHGlobal(4);

        IntPtr game = rootGame;
        int gens = path.Length + 1;
        for (int k = 0; k < gens; k++)
        {
            IntPtr outBuf = (k % 2 == 0) ? bufA : bufB;
            Marshal.WriteInt32(countPtr, 0);
            Invoke(miExpand, game, outBuf, countPtr);
            int count = Marshal.ReadInt32(countPtr);
            if (count < 0) count = 0;
            if (count > NodeCap) count = NodeCap;
            int depth = k + 1;
            bool first = k == 0;
            int trust = first ? 10 : (depth > viewNext + 2 ? 9 : 10);
            if (!first) Invoke(miSetTrust, depth);
            Log("GEN " + k + " depth=" + depth + " mode=" + (first ? "first" : "eval")
                + " trust=" + trust + " count=" + count
                + " curFallM=" + Marshal.ReadInt32(game, 44)
                + " curHoldM=" + Marshal.ReadInt32(game, 16)
                + " curCombo=" + Marshal.ReadInt32(game, 288)
                + " curBtb=" + Marshal.ReadInt32(game, 292)
                + " curStack=" + Marshal.ReadInt32(game, 224));
            for (int i = 0; i < count; i++)
            {
                IntPtr child = new IntPtr(outBuf.ToInt64() + i * NodeStride);
                DumpEvalChild("E " + k + " " + i, child, first, rootNext, em, chPtr, wcPtr, wdPtr, scorePtr, fsPtr);
            }
            if (k >= path.Length) break;
            int sel = -1;
            int matches = 0;
            for (int i = 0; i < count; i++)
            {
                IntPtr child = new IntPtr(outBuf.ToInt64() + i * NodeStride);
                if (Marshal.ReadInt32(child, 64) == path[k][0]
                    && (Marshal.ReadInt32(child, 72) & 3) == path[k][1]
                    && (path[k][2] < 0 || Marshal.ReadInt32(child, 76) == path[k][2])
                    && (path[k][3] < 0 || Marshal.ReadInt32(child, 296) == path[k][3]))
                {
                    if (sel < 0) sel = i;
                    matches++;
                }
            }
            if (sel < 0)
            {
                Log("PATH " + k + " NOT_FOUND x=" + path[k][0] + " rot=" + path[k][1] + " m=" + path[k][2]);
                break;
            }
            Log("PATH " + k + " sel=" + sel + " matches=" + matches + " x=" + path[k][0] + " rot=" + path[k][1] + " m=" + path[k][2]);
            game = new IntPtr(outBuf.ToInt64() + sel * NodeStride);
        }

        Marshal.FreeHGlobal(countPtr);
        Marshal.FreeHGlobal(bufA);
        Marshal.FreeHGlobal(bufB);
    }

    private static void RunEvalBfs(IntPtr rootGame, MethodInfo miExpand, MethodInfo miSetTrust,
        int viewNext, EvalMethods em, IntPtr chPtr, IntPtr wcPtr, IntPtr wdPtr, IntPtr scorePtr, IntPtr fsPtr)
    {
        IntPtr bufA = Marshal.AllocHGlobal(NodeStride * NodeCap);
        IntPtr bufB = Marshal.AllocHGlobal(NodeStride * NodeCap);
        IntPtr countPtr = Marshal.AllocHGlobal(4);
        IntPtr rootNext = Marshal.ReadIntPtr(rootGame, 0);

        Marshal.WriteInt32(countPtr, 0);
        Invoke(miExpand, rootGame, bufA, countPtr);
        int count1 = Marshal.ReadInt32(countPtr);
        if (count1 < 0) count1 = 0;
        if (count1 > NodeCap) count1 = NodeCap;
        Log("GEN 0 depth=1 mode=first trust=10 count=" + count1
            + " curFallM=" + Marshal.ReadInt32(rootGame, 44)
            + " curHoldM=" + Marshal.ReadInt32(rootGame, 16)
            + " curCombo=" + Marshal.ReadInt32(rootGame, 288)
            + " curBtb=" + Marshal.ReadInt32(rootGame, 292)
            + " curStack=" + Marshal.ReadInt32(rootGame, 224));
        for (int i = 0; i < count1; i++)
        {
            IntPtr child = new IntPtr(bufA.ToInt64() + i * NodeStride);
            DumpEvalChild("E 0 " + i, child, true, rootNext, em, chPtr, wcPtr, wdPtr, scorePtr, fsPtr);
        }

        int trust = 2 > viewNext + 2 ? 9 : 10;
        Invoke(miSetTrust, 2);
        for (int p = 0; p < count1; p++)
        {
            IntPtr parent = new IntPtr(bufA.ToInt64() + p * NodeStride);
            Marshal.WriteInt32(countPtr, 0);
            Invoke(miExpand, parent, bufB, countPtr);
            int count2 = Marshal.ReadInt32(countPtr);
            if (count2 < 0) count2 = 0;
            if (count2 > NodeCap) count2 = NodeCap;
            Log("B " + p + " depth=2 trust=" + trust + " count=" + count2
                + " curFallM=" + Marshal.ReadInt32(parent, 44)
                + " curHoldM=" + Marshal.ReadInt32(parent, 16)
                + " curCombo=" + Marshal.ReadInt32(parent, 288)
                + " curBtb=" + Marshal.ReadInt32(parent, 292)
                + " curStack=" + Marshal.ReadInt32(parent, 224));
            for (int i = 0; i < count2; i++)
            {
                IntPtr child = new IntPtr(bufB.ToInt64() + i * NodeStride);
                DumpEvalChild("EB " + p + " " + i, child, false, rootNext, em, chPtr, wcPtr, wdPtr, scorePtr, fsPtr);
            }
        }

        Marshal.FreeHGlobal(countPtr);
        Marshal.FreeHGlobal(bufA);
        Marshal.FreeHGlobal(bufB);
    }

    private static void DumpEvalChild(string label, IntPtr child, bool first, IntPtr rootNext,
        EvalMethods em, IntPtr chPtr, IntPtr wcPtr, IntPtr wdPtr, IntPtr scorePtr, IntPtr fsPtr)
    {
        int score;
        int fscore;
        Marshal.WriteInt32(fsPtr, 0);
        if (first)
        {
            Invoke(em.EvalFirst, child, fsPtr);
            fscore = Marshal.ReadInt32(fsPtr);
            score = fscore;
        }
        else
        {
            Marshal.WriteInt32(scorePtr, 0);
            Invoke(em.Eval, child, scorePtr, fsPtr);
            score = Marshal.ReadInt32(scorePtr);
            fscore = Marshal.ReadInt32(fsPtr);
        }

        for (int c = 0; c < 10; c++) Marshal.WriteInt32(chPtr, c * 4, -1);
        int minH = CallInt(em.ColumnHeight, new IntPtr(child.ToInt64() + 96), chPtr);
        int height = CallInt(em.GetHeight, child, chPtr);
        Marshal.WriteInt32(wcPtr, -1);
        Marshal.WriteInt32(wdPtr, 0);
        int well = CallInt(em.GetWell, child, chPtr, minH, wcPtr, wdPtr);
        int wellCol = Marshal.ReadInt32(wcPtr);
        int wellDepth = Marshal.ReadInt32(wdPtr);
        int updown = CallInt(em.UpDown, child, chPtr, wellCol, wellDepth);
        int under = CallInt(em.Under, child, chPtr, minH);
        int y0 = wellDepth + minH;
        int ground = CallInt(em.Ground, child, chPtr, y0);
        int res = CallInt(em.Resource, child, chPtr, minH);
        int tsd = CallInt(em.Tsd, child, chPtr, y0);
        int tst = CallInt(em.Tst, child, chPtr, y0, minH);
        int pc = CallInt(em.Pc, child, minH);
        int cont = CallInt(em.Cont, child);
        int action = CallInt(em.Action, child);
        int board = height + well + updown + under + ground + res + tsd + tst + pc + cont;

        IntPtr nextPtr = Marshal.ReadIntPtr(child, 0);
        IntPtr trustPtr = Marshal.ReadIntPtr(child, 8);
        long baseRel = (nextPtr.ToInt64() - rootNext.ToInt64()) / 4L;
        long win = (trustPtr.ToInt64() - nextPtr.ToInt64()) / 4L;

        StringBuilder sb = new StringBuilder(640);
        sb.Append(label);
        sb.Append(" hold=0 x=").Append(Marshal.ReadInt32(child, 64));
        sb.Append(" y=").Append(Marshal.ReadInt32(child, 68));
        sb.Append(" rot=").Append(Marshal.ReadInt32(child, 72) & 3);
        sb.Append(" m=").Append(Marshal.ReadInt32(child, 76));
        sb.Append(" act=").Append(Marshal.ReadInt32(child, 296));
        sb.Append(" delay=").Append(Marshal.ReadInt32(child, 280));
        sb.Append(" combo=").Append(Marshal.ReadInt32(child, 288));
        sb.Append(" btb=").Append(Marshal.ReadInt32(child, 292));
        sb.Append(" stack=").Append(Marshal.ReadInt32(child, 224));
        sb.Append(" nextBase=").Append(baseRel);
        sb.Append(" trustEnd=").Append(baseRel + win);
        sb.Append(" win=").Append(win);
        sb.Append(" fall=").Append(Marshal.ReadInt32(child, 32)).Append(',')
            .Append(Marshal.ReadInt32(child, 36)).Append(',')
            .Append(Marshal.ReadInt32(child, 40)).Append(',')
            .Append(Marshal.ReadInt32(child, 44)).Append(',')
            .Append(Marshal.ReadInt32(child, 48));
        sb.Append(" lock=").Append(Marshal.ReadInt32(child, 64)).Append(',')
            .Append(Marshal.ReadInt32(child, 68)).Append(',')
            .Append(Marshal.ReadInt32(child, 72)).Append(',')
            .Append(Marshal.ReadInt32(child, 76)).Append(',')
            .Append(Marshal.ReadInt32(child, 80));
        sb.Append(" | ch=");
        for (int c = 0; c < 10; c++)
        {
            if (c > 0) sb.Append(',');
            sb.Append(Marshal.ReadInt32(chPtr, c * 4));
        }
        sb.Append(" | minH=").Append(minH);
        sb.Append(" height=").Append(height);
        sb.Append(" well=").Append(well);
        sb.Append(" wellCol=").Append(wellCol);
        sb.Append(" wellDepth=").Append(wellDepth);
        sb.Append(" updown=").Append(updown);
        sb.Append(" under=").Append(under);
        sb.Append(" ground=").Append(ground);
        sb.Append(" res=").Append(res);
        sb.Append(" tsd=").Append(tsd);
        sb.Append(" tst=").Append(tst);
        sb.Append(" pc=").Append(pc);
        sb.Append(" cont=").Append(cont);
        sb.Append(" action=").Append(action);
        sb.Append(" board=").Append(board);
        sb.Append(" fscore=").Append(fscore);
        sb.Append(" score=").Append(score);
        sb.Append(" rows=");
        for (int r = 0; r < 32; r++)
        {
            if (r > 0) sb.Append(',');
            sb.Append(Marshal.ReadInt32(child, 96 + r * 4));
        }
        Log(sb.ToString());
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
