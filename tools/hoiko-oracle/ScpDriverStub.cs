// ScpDriverInterface.dll replacement (a MANAGED assembly). Serves two purposes:
//  1) no-op stubs so Hoiko.exe's C++ module initializer no longer throws
//     "SCP Virtual Bus Device not found", allowing the mixed-mode main module to load;
//  2) an oracle worker that reflects Hoiko's global <Module> search methods and runs
//     SearchAI.Search on a synthetic position, dumping results to console + a file.
//
// C#5-compatible (Wine .NET Framework csc-compatible).
// allow: SIZE_OK — single-file oracle stub; the raw binary RVAs are the contract.

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
    // Arena-dump mode (`tree_dump=1`): after SearchAI.Search, write the native
    // node arena (`?tree@SearchAI`, RVA 0x663D8) to oracle_tree.bin so beam
    // membership/order at every generation can be diffed against the replica.
    private static int _treeDump;
    // Search-global overrides for regime checks: `depthlimit=10` writes
    // SearchAI.depthLimit (RVA 0x663F4) and `usehold=0` writes ExpandAI.useHold
    // (RVA 0x663D0) right before Search, so the oracle can reproduce the
    // replica's non-default test regimes (default -1 = leave untouched).
    private static int _depthLimitOverride = -1;
    private static int _useHoldOverride = -1;
    // Optional falling-piece spawn height (`fally=`), written after the board so
    // the searched state matches the replica's `build_root` spawn. -1 = leave it.
    private static int _fallY = -1;
    // Next-queue carry probe (`shiftnext=N`): after RootNode.Init, replay the
    // real `RootNode.SetPPTData` mutation N times — each turn `NextMino.ShiftNext`
    // then `NextMino.Compare(root, 0, nx)` (IL 7048-7049) — then `SetNewCurrent`.
    // Exposes the turn-N bag/trust state the harness must reproduce.
    private static int _shiftNext;
    // `shiftiter=N`: replay N full per-turn mutations after `RootNode.Init`
    // (`ShiftNext; Compare(0,nx); SetNewCurrent` each iteration) — the exact
    // sequence the harness applies across N versus turns.
    private static int _shiftIter;
    // `carrym=`, `carrytrust=`, `carryrem=`: seed the persistent NextMino with a
    // recorded carry state (after Init) instead of the fresh bag. Lets the exe
    // search from the same queue state the replica carries across turns.
    private static int[] _carryM;
    private static int _carryTrust = int.MinValue;
    private static int _carryRem = int.MinValue;
    // `nextdump=1`: print the root NextMino state (m[0..9], trustEnd, bagRemains)
    // after Init / shiftnext and before the search, then exit without searching.
    private static int _nextDump;
    // ConfigAI/TemplateAI static overrides (`viewnext=`, `usepcstack=`, `uses4w=`,
    // `usetdopeners=`) so the oracle can enable config options the shipping
    // config.dll has off. -1 = leave the static untouched. Applied before
    // `SearchAI.ReadConfig` so EvaluateAI/TemplateAI derive their flags exactly
    // as they would from a changed config.dll.
    private static int _viewNextOverride = -1;
    private static int _pcStackOverride = -1;
    private static int _s4wOverride = -1;
    private static int _tdOpenersOverride = -1;
    private static int _loopTemplateOverride = -1;
    // Direct TemplateAI phase overrides (`optype=`, `opdropcount=`): let a single
    // Search observe a later template phase without replaying the whole game.
    private static int _opTypeOverride = -1;
    private static int _opDropCountOverride = int.MinValue;
    // Stepwise OpExpand probe (`opexpand=1`): calls ExpandTemplateNode →
    // OpExpandDeriveNode → OpExpandNode → RegistChildNode on the root and logs
    // the baby arena, to localize template-path failures without a full search.
    private static int _opExpandProbe;
    // `ecbig=1`: re-point ExpandAI.expandedChild at a zeroed 256-bucket table
    // (the shipping table is 40 buckets x 20 slots and can overflow).
    private static int _ecBig;
    // `tmpl=1`: call the pure TemplateAI decision/scoring functions directly on
    // the root GamePack, in a fixed order, logging each result and the statics.
    private static int _tmplProbe;
    // Synthetic locked-mino / carry state for the tmpl probe (`lockx=` etc.).
    private static int _lockX = int.MinValue;
    private static int _lockY = int.MinValue;
    private static int _lockR = int.MinValue;
    private static int _lockM = int.MinValue;
    private static int _fallX = int.MinValue;
    private static int _fallR = int.MinValue;
    private static int _fallM = int.MinValue;
    private static int _prevOpOverride = int.MinValue;
    private static int _remainsOverride = int.MinValue;
    // Hold slot mino (opt-in via `hold=`): default 7 == MinoType.NONE, which is
    // exactly what HoldMino.Init writes, so omitting the key is behavior-preserving.
    private static int _hold = 7;
    // Carried `Others` state (opt-in via `combo=` / `b2b=`), default 0 like Others.Init.
    private static int _combo;
    private static int _btb;
    // --- OffsetOffAI driver mode (opt-in via `offsetenabled=`) ---
    // Pending garbage rows (`garbage=`) and the virtual frame clock (`nowms=`)
    // mirror `HSearchInput.pending_garbage` / `now_ms` in the Rust ABI.
    private static int _pendingGarbage;
    private static int _nowMs;
    // -1 = legacy mode: do not touch the OffsetOffAI statics or call its methods.
    private static int _offsetEnabled = -1;
    // Own/opponent lock sync (mirrors HoikoOffsetDriver.sync): opt-in via `sync=1`.
    private static int _syncEnabled;
    private static int _syncLockId;
    private static int _syncLastAction;
    private static int _syncLastAttack;
    private static int _syncHasOppLock;
    private static int _syncOppLockId;
    private static int _syncOppClearLines;
    private static int _syncOppBtb;
    private static int _syncOppCombo;
    // Carried OffsetOffAI state (raw statics), mirrors HSearchInput.ofs_*/gb_*.
    private static int _useOffsetOff;
    private static int _ofsCanWait;
    private static int _ofsCenter4;
    private static int _ofsAtk;
    private static int _ofsPcChance;
    private static int _ofsNearOffset;
    private static int _gbOpponentsAtk;
    private static int _gbCoolTime;
    private static int _gbRemainingTime;
    private static int _gbOpponentsLockCount;
    private static int _gbFirstInvalidLock;
    // Driver-side lock bookkeeping (mirrors HSearchInput.has_last_*).
    private static int _hasLastOwn;
    private static int _lastOwnId;
    private static int _hasLastOpp;
    private static int _lastOppId;
    // `iseven=` override (RVA 0x66382). -1 = leave the static untouched.
    private static int _isEvenBoard = -1;
    // --- Versus opponent-aware EvaluateAI statics (real-game `PPT2AI.ObserveOpponent`
    // + `NextTurn` path). All opt-in; -1/int.MinValue = leave untouched:
    //   multieval=0/1  -> EvaluateAI.MultiEvaluation(bool)  (0x060001CD)
    //   opppc=0/1      -> EvaluateAI.OpponentIsPCBoard(bool) (0x060001D0)
    //   opppowerful=0/1-> EvaluateAI.OpponentIsPowerfulBoard(bool) (0x060001D3)
    //   oppcombo=N     -> EvaluateAI.SetOpponentsCombo(N)   (0x060001D2)
    //   evenodd=1      -> EvaluateAI.EvenOrOdd(root) before Search (0x060001CB),
    //                     which is exactly what the versus `QuickSearch` does
    //                     (`isEvenBoard = PopCount(root board) even`).
    private static int _multiEval = -1;
    private static int _oppPcSet = -1;
    private static int _oppPowerfulSet = -1;
    private static int _oppComboSet = int.MinValue;
    private static int _evenOdd = -1;
    // `vsprobe=1`: call the real `EvaluateAI.OpponentIsPCBoard(Board*)` /
    // `OpponentIsPowerfulBoard(Board*, combo, garbage)` on a synthetic opponent
    // board (`oppboard=` native rows; `oppcombo=`/`garbage=` inputs), dump the two
    // booleans, then exit without searching. Verifies the derivation formula.
    private static int _vsProbe;
    private static readonly int[] _oppBoard = new int[32];
    // Carried `EvaluateAI.weight` family index (weightList + 272*index). A fresh
    // process always starts at 0, so the harness restores the replica's carried
    // index and reads the post-search index back (adapter carries it too).
    private static int _weightIndex = -1;
    private static int _outWeightIndex = -1;
    // Values computed by the offset decision this run.
    private static int _garbageWait;
    private static int _outUseOffsetOff;
    private static int _outOfsCanWait;
    private static int _outOfsCenter4;
    private static int _outOfsAtk;
    private static int _outOfsPcChance;
    private static int _outOfsNearOffset;
    private static int _outGbOpponentsAtk;
    private static int _outGbCoolTime;
    private static int _outGbRemainingTime;
    private static int _outGbOpponentsLockCount;
    private static int _outGbFirstInvalidLock;
    private static MethodInfo _miUseOff;
    private static MethodInfo _miCanOff;
    private static MethodInfo _miDecOff;
    private static MethodInfo _miResetAtk;
    private static MethodInfo _miCalcAtk;
    private static MethodInfo _miGetAtk;
    private static MethodInfo _miSetPrev;
    private static MethodInfo _miLockOff;
    private static MethodInfo _miOppNew;
    private static MethodInfo _miInvAtk;
    private static MethodInfo _miIsLocked;
    private static MethodInfo _miFirstInvalid;
    private static bool _offsetMethodsResolved;
    // Native RVAs of the OffsetOffAI statics in the loaded Hoiko module
    // (monodis --fields: isEvenBoard 418690, useOffsetOff 418700, ofsData 418704,
    // gbData 418720; base = Marshal.GetHINSTANCE).
    private const int RvaIsEvenBoard = 0x66382;
    private const int RvaUseOffsetOff = 0x6638C;
    private const int RvaOfsData = 0x66390;
    private const int RvaGbData = 0x663A0;
    // ConfigAI / TemplateAI statics (monodis --fields): viewNext 418588,
    // useTDOpeners 418600, usePCstack 418617, useS4W 418618,
    // EvaluateAI.useS4W 418689, TemplateAI.useTDOpeners 418812.
    private const int RvaConfigViewNext = 0x6631C;
    private const int RvaConfigUseTDOpeners = 0x66328;
    private const int RvaConfigUsePCstack = 0x66339;
    private const int RvaConfigUseS4W = 0x6633A;
    private const int RvaEvalUseS4W = 0x66381;
    private const int RvaTemplateUseTDOpeners = 0x663FC;
    // ExpandAI / TemplateAI statics (monodis: `.field ... at D_xxxx`).
    private const int RvaExpandBabyNode = 0x663B8;
    private const int RvaExpandExpandedBaby = 0x663C0;
    private const int RvaExpandExpandedChild = 0x663C8;
    private const int RvaSearchTree = 0x663D8;
    private const int RvaTemplateUseTemplate = 0x663FD;
    private const int RvaTemplateOpType = 0x66400;
    private const int RvaTemplateFailTDOpeners = 0x66404;
    private const int RvaTemplateOpDropCount = 0x66408;
    private const int RvaTemplateUseDPC = 0x6640C;
    private const int RvaTemplateLoopTemplate = 0x6640D;
    private const int RvaTemplatePrevOpDropCount = 0x66410;
    private const int RvaConfigLoopTemplate = 0x6633C;
    // Method token of TemplateAI.ReadConfig (monodis --method index 542 -> 0x06000000+542).
    private const int TokenTemplateReadConfig = 0x0600021E;
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

        int[] seq = new int[] { 0,1,2,3,4,5,6, 0,1,2,3,4,5,6, 0,1,2,3,4,5,6, 0,1,2,3,4,5,6 };
        int[] board = new int[32];
        board[0] = 0x1FF;
        board[1] = 0x001;
        board[2] = 0x001;
        board[3] = 0x001;
        LoadInput(ref seq, board);

        if (!_initDone)
        {
            Log("[1] ConfigAI.ReadConfig"); Invoke(miConfigRead);
            ApplyConfigOverrides();
            Log("[2] SearchAI.Init"); Invoke(miSearchInit);
            Log("[3] SearchAI.ReadConfig"); Invoke(miSearchReadConfig);
            // ReadConfig (re)derives TemplateAI/ExpandAI statics, so apply the
            // harness overrides again to keep them effective for the search.
            ApplyConfigOverrides();
            _initDone = true;
        }
        else
        {
            ApplyConfigOverrides();
        }

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
        if (_shiftNext > 0 || _shiftIter > 0 || _nextDump != 0 || _carryM != null)
        {
            MethodInfo miShift = Resolve(0, "NextMino.ShiftNext", 1);
            MethodInfo miCompare = Resolve(0, "NextMino.Compare", 3);
            MethodInfo miSetCurrent = Resolve(0, "RootNode.SetNewCurrent", 1);
            if (miSetCurrent == null)
            {
                Log("[next] shift/compare methods not resolved: shift=" + (miShift != null)
                    + " compare=" + (miCompare != null) + " setCurrent=" + (miSetCurrent != null));
            }
            else if (_carryM != null)
            {
                for (int i = 0; i < 28 && i < _carryM.Length; i++)
                    Marshal.WriteInt32(buf, i * 4, _carryM[i]);
                if (_carryTrust != int.MinValue) Marshal.WriteInt32(buf, 112, _carryTrust);
                if (_carryRem != int.MinValue) Marshal.WriteInt32(buf, 116, _carryRem);
                Invoke(miSetCurrent, buf);
                Log("[next] carry injected (m[0]=" + _carryM[0] + " trustEnd="
                    + Marshal.ReadInt32(buf, 112) + " remains=" + Marshal.ReadInt32(buf, 116) + ")");
            }
            else if (miShift == null || miCompare == null)
            {
                Log("[next] shift/compare methods not resolved: shift=" + (miShift != null)
                    + " compare=" + (miCompare != null) + " setCurrent=" + (miSetCurrent != null));
            }
            else if (_shiftIter > 0)
            {
                for (int s = 0; s < _shiftIter; s++)
                {
                    Invoke(miShift, buf);
                    Invoke(miCompare, buf, 0, nx);
                    Invoke(miSetCurrent, buf);
                }
                Log("[next] applied " + _shiftIter + " x (ShiftNext + Compare(0,nx) + SetNewCurrent)");
            }
            else
            {
                for (int s = 0; s < _shiftNext; s++)
                {
                    Invoke(miShift, buf);
                    Invoke(miCompare, buf, 0, nx);
                }
                Invoke(miSetCurrent, buf);
                Log("[next] applied " + _shiftNext + " x (ShiftNext + Compare(0,nx)) + SetNewCurrent");
            }
            DumpNextState(buf, _shiftIter > 0 ? _shiftIter : _shiftNext);
            if (_nextDump == 1)
            {
                Marshal.FreeHGlobal(buf);
                Marshal.FreeHGlobal(nx);
                return true;
            }
        }
        if (_fallY >= 0) Marshal.WriteInt32(buf, OffFalling + 4, _fallY);
        if (_fallX != int.MinValue) Marshal.WriteInt32(buf, OffFalling, _fallX);
        if (_fallR != int.MinValue) Marshal.WriteInt32(buf, OffFalling + 8, _fallR);
        if (_fallM != int.MinValue) Marshal.WriteInt32(buf, OffFalling + 12, _fallM);
        if (_lockX != int.MinValue) Marshal.WriteInt32(buf, OffFalling + 32, _lockX);
        if (_lockY != int.MinValue) Marshal.WriteInt32(buf, OffFalling + 36, _lockY);
        if (_lockR != int.MinValue) Marshal.WriteInt32(buf, OffFalling + 40, _lockR);
        if (_lockM != int.MinValue) Marshal.WriteInt32(buf, OffFalling + 44, _lockM);
        if (_remainsOverride != int.MinValue) Marshal.WriteInt32(buf, 116, _remainsOverride);
        Marshal.WriteInt32(buf, OffHold, _hold);
        Marshal.WriteInt32(buf, OffCombo, _combo);
        Marshal.WriteInt32(buf, OffBtb, _btb);
        Log("  input hold @136 = " + _hold + ", combo @408 = " + _combo + ", btb @412 = " + _btb);
        Log("  board.stackHeight @344 = " + Marshal.ReadInt32(buf, 344));
        Log("  fallingMino @152: x=" + Marshal.ReadInt32(buf, 152) + " y=" + Marshal.ReadInt32(buf, 156) + " r=" + Marshal.ReadInt32(buf, 160) + " m=" + Marshal.ReadInt32(buf, 164));

        if (_offsetEnabled >= 0)
        {
            Log("[4b] offset driver input");
            ApplyOffsetInput();
        }
        else if (_isEvenBoard >= 0)
        {
            SetEvenBoard(_isEvenBoard != 0);
        }
        if (_weightIndex >= 0) ApplyWeightIndex();
        ApplyVsStatics();

        if (_vsProbe != 0)
        {
            Log("[5] versus derivation probe (SearchAI.Search skipped)");
            RunVsProbe();
            Marshal.FreeHGlobal(buf);
            Marshal.FreeHGlobal(nx);
            return true;
        }

        if (_tmplProbe != 0)
        {
            Log("[5] template decision probe (SearchAI.Search skipped)");
            RunTemplateProbe(buf);
            Marshal.FreeHGlobal(buf);
            Marshal.FreeHGlobal(nx);
            return true;
        }

        if (_opExpandProbe != 0)
        {
            Log("[5] op-expand stepwise probe (SearchAI.Search skipped)");
            RunOpExpandProbe(buf);
            Marshal.FreeHGlobal(buf);
            Marshal.FreeHGlobal(nx);
            return true;
        }

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
        if (_depthLimitOverride >= 0 || _useHoldOverride >= 0)
        {
            IntPtr hinst = Marshal.GetHINSTANCE(_asm.ManifestModule);
            if (_depthLimitOverride >= 0)
                Marshal.WriteInt32(new IntPtr(hinst.ToInt64() + 0x663F4), _depthLimitOverride);
            if (_useHoldOverride >= 0)
                Marshal.WriteByte(new IntPtr(hinst.ToInt64() + 0x663D0), (byte)_useHoldOverride);
            Log("[override] depthLimit=" + Marshal.ReadInt32(new IntPtr(hinst.ToInt64() + 0x663F4))
                + " useHold=" + Marshal.ReadByte(new IntPtr(hinst.ToInt64() + 0x663D0)));
        }
        if (_startTimer && miIsSearching != null)
        {
            Log("[4d] SearchAI.IsSearching(true)  (starts timer, limit=1000ms)");
            Invoke(miIsSearching, true);
        }
        if (_ecBig != 0)
        {
            IntPtr ecNew = Marshal.AllocHGlobal(168 * 256);
            for (int i = 0; i < 168 * 256; i += 8) Marshal.WriteInt64(ecNew, i, 0L);
            Marshal.WriteIntPtr(new IntPtr(ModuleBase().ToInt64() + RvaExpandExpandedChild), ecNew);
            Log("[ecbig] expandedChild -> 0x" + ecNew.ToInt64().ToString("x") + " (256 zeroed buckets)");
        }

        DumpTemplateStatics("pre");
        if (_evenOdd == 1) Invoke(Resolve(0x060001CB, "EvaluateAI.EvenOrOdd", 1), buf);
        Invoke(miSearch, buf);
        DumpTemplateStatics("post");
        Log("[5] returned in " + (DateTime.UtcNow - t0).TotalMilliseconds.ToString("0.0", CultureInfo.InvariantCulture) + " ms");
        if (_weightIndex >= 0) ReadWeightIndex();
        if (_offsetEnabled >= 0) RunOffsetDecision(buf);
        if (_treeDump != 0) DumpTree();

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
            else if (key == "tree_dump")
            {
                _treeDump = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "depthlimit")
            {
                _depthLimitOverride = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "usehold")
            {
                _useHoldOverride = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "positions_file")
            {
                _expandMultiFile = val;
            }
            else if (key == "fally")
            {
                _fallY = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "shiftnext")
            {
                _shiftNext = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "shiftiter")
            {
                _shiftIter = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "carrym")
            {
                _carryM = new int[parts.Length];
                for (int i = 0; i < parts.Length && i < 28; i++)
                    _carryM[i] = int.Parse(parts[i].Trim(), CultureInfo.InvariantCulture);
            }
            else if (key == "carrytrust")
            {
                _carryTrust = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "carryrem")
            {
                _carryRem = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "nextdump")
            {
                _nextDump = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "viewnext")
            {
                _viewNextOverride = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "usepcstack")
            {
                _pcStackOverride = val != "0" ? 1 : 0;
            }
            else if (key == "uses4w")
            {
                _s4wOverride = val != "0" ? 1 : 0;
            }
            else if (key == "usetdopeners")
            {
                _tdOpenersOverride = val != "0" ? 1 : 0;
            }
            else if (key == "looptemplate")
            {
                _loopTemplateOverride = val != "0" ? 1 : 0;
            }
            else if (key == "optype")
            {
                _opTypeOverride = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "opdropcount")
            {
                _opDropCountOverride = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "opexpand")
            {
                _opExpandProbe = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "ecbig")
            {
                _ecBig = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "tmpl")
            {
                _tmplProbe = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "lockx") _lockX = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "locky") _lockY = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "lockr") _lockR = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "lockm") _lockM = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "fallx") _fallX = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "fallr") _fallR = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "fallm") _fallM = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "prevop") _prevOpOverride = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "remains") _remainsOverride = int.Parse(val, CultureInfo.InvariantCulture);
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
            else if (key == "garbage" || key == "pending_garbage")
            {
                _pendingGarbage = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "nowms" || key == "sync_now_ms")
            {
                _nowMs = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "offsetenabled" || key == "offset_enabled")
            {
                _offsetEnabled = val != "0" ? 1 : 0;
            }
            else if (key == "iseven")
            {
                _isEvenBoard = val != "0" ? 1 : 0;
            }
            else if (key == "multieval")
            {
                _multiEval = val != "0" ? 1 : 0;
            }
            else if (key == "opppc")
            {
                _oppPcSet = val != "0" ? 1 : 0;
            }
            else if (key == "opppowerful")
            {
                _oppPowerfulSet = val != "0" ? 1 : 0;
            }
            else if (key == "oppcombo")
            {
                _oppComboSet = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "evenodd")
            {
                _evenOdd = val != "0" ? 1 : 0;
            }
            else if (key == "vsprobe")
            {
                _vsProbe = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "oppboard")
            {
                for (int i = 0; i < parts.Length && i < 32; i++)
                    _oppBoard[i] = (int)long.Parse(parts[i].Trim().Replace("0x", ""), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            }
            else if (key == "weightindex")
            {
                _weightIndex = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "sync" || key == "sync_enabled")
            {
                _syncEnabled = val != "0" ? 1 : 0;
            }
            else if (key == "useoffset" || key == "use_offset_off")
            {
                _useOffsetOff = int.Parse(val, CultureInfo.InvariantCulture);
            }
            else if (key == "ofscanwait") _ofsCanWait = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "ofscenter4") _ofsCenter4 = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "ofsatk") _ofsAtk = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "ofspcchance") _ofsPcChance = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "ofsnearoffset") _ofsNearOffset = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "gboppatk") _gbOpponentsAtk = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "gbcool") _gbCoolTime = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "gbremaining") _gbRemainingTime = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "gblockcount") _gbOpponentsLockCount = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "gbfirstinvalid") _gbFirstInvalidLock = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "haslastown") _hasLastOwn = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "lastownid") _lastOwnId = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "haslastopp") _hasLastOpp = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "lastoppid") _lastOppId = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "lockid") _syncLockId = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "lastaction") _syncLastAction = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "lastattack") _syncLastAttack = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "opplock") _syncHasOppLock = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "opplockid") _syncOppLockId = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "oppclear") _syncOppClearLines = int.Parse(val, CultureInfo.InvariantCulture);
            else if (key == "oppbtb") _syncOppBtb = int.Parse(val, CultureInfo.InvariantCulture);
            // Sync-field name (`_syncOppCombo`); `oppcombo=` is the versus static
            // `EvaluateAI.SetOpponentsCombo` and must not be reused here.
            else if (key == "opplastcombo") _syncOppCombo = int.Parse(val, CultureInfo.InvariantCulture);
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

    private static void DumpNextState(IntPtr root, int shift)
    {
        StringBuilder sb = new StringBuilder("NEXTDUMP shift=" + shift + " m=");
        for (int i = 0; i < 28; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(Marshal.ReadInt32(root, i * 4));
        }
        sb.Append(" trustEnd=").Append(Marshal.ReadInt32(root, 112));
        sb.Append(" remains=").Append(Marshal.ReadInt32(root, 116));
        Log(sb.ToString());
        StringBuilder full = new StringBuilder("NEXTFULL shift=" + shift + " m=");
        for (int i = 0; i < 28; i++)
        {
            if (i > 0) full.Append(',');
            full.Append(Marshal.ReadInt32(root, i * 4));
        }
        Log(full.ToString());
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

    private static void ApplyVsStatics()
    {
        if (_multiEval >= 0) Invoke(Resolve(0x060001CD, "EvaluateAI.MultiEvaluation", 1), _multiEval != 0);
        if (_oppPcSet >= 0) Invoke(Resolve(0x060001D0, "EvaluateAI.OpponentIsPCBoard", 1), _oppPcSet != 0);
        if (_oppPowerfulSet >= 0)
            Invoke(Resolve(0x060001D3, "EvaluateAI.OpponentIsPowerfulBoard", 1), _oppPowerfulSet != 0);
        if (_oppComboSet != int.MinValue)
            Invoke(Resolve(0x060001D2, "EvaluateAI.SetOpponentsCombo", 1), _oppComboSet);
    }

    private static void RunVsProbe()
    {
        MethodInfo miPc = Resolve(0x060001D1, "EvaluateAI.OpponentIsPCBoard", 1);
        MethodInfo miPowerful = Resolve(0x060001D4, "EvaluateAI.OpponentIsPowerfulBoard", 3);
        IntPtr bd = Marshal.AllocHGlobal(136);
        for (int i = 0; i < 136; i += 4) Marshal.WriteInt32(bd, i, 0);
        int sh = -1;
        for (int y = 0; y < 32; y++)
        {
            Marshal.WriteInt32(bd, y * 4, _oppBoard[y]);
            if (_oppBoard[y] != 0) sh = y;
        }
        Marshal.WriteInt32(bd, 128, sh);
        int combo = _oppComboSet == int.MinValue ? 0 : _oppComboSet;
        bool pc = CallBool(miPc, bd);
        bool powerful = CallBool(miPowerful, bd, combo, _pendingGarbage);
        Log("VSPROBE oppPc=" + (pc ? 1 : 0) + " oppPowerful=" + (powerful ? 1 : 0)
            + " stackHeight=" + sh + " combo=" + combo + " garbage=" + _pendingGarbage);
        Marshal.FreeHGlobal(bd);
    }

    private static void ApplyConfigOverrides()
    {
        if (_viewNextOverride < 0 && _pcStackOverride < 0 && _s4wOverride < 0
            && _tdOpenersOverride < 0 && _loopTemplateOverride < 0
            && _opTypeOverride < 0 && _opDropCountOverride < 0) return;
        IntPtr h = ModuleBase();
        if (_viewNextOverride >= 0)
            Marshal.WriteInt32(new IntPtr(h.ToInt64() + RvaConfigViewNext), _viewNextOverride);
        if (_pcStackOverride >= 0)
            Marshal.WriteByte(new IntPtr(h.ToInt64() + RvaConfigUsePCstack),
                (byte)(_pcStackOverride != 0 ? 1 : 0));
        if (_s4wOverride >= 0)
        {
            Marshal.WriteByte(new IntPtr(h.ToInt64() + RvaConfigUseS4W),
                (byte)(_s4wOverride != 0 ? 1 : 0));
            Marshal.WriteByte(new IntPtr(h.ToInt64() + RvaEvalUseS4W),
                (byte)(_s4wOverride != 0 ? 1 : 0));
        }
        if (_tdOpenersOverride >= 0)
        {
            Marshal.WriteByte(new IntPtr(h.ToInt64() + RvaConfigUseTDOpeners),
                (byte)(_tdOpenersOverride != 0 ? 1 : 0));
            Marshal.WriteByte(new IntPtr(h.ToInt64() + RvaTemplateUseTDOpeners),
                (byte)(_tdOpenersOverride != 0 ? 1 : 0));
            InvokeTemplateReadConfig();
        }
        if (_loopTemplateOverride >= 0)
        {
            Marshal.WriteByte(new IntPtr(h.ToInt64() + RvaConfigLoopTemplate),
                (byte)(_loopTemplateOverride != 0 ? 1 : 0));
            Marshal.WriteByte(new IntPtr(h.ToInt64() + RvaTemplateLoopTemplate),
                (byte)(_loopTemplateOverride != 0 ? 1 : 0));
            InvokeTemplateReadConfig();
        }
        // Phase overrides go last: they deliberately bypass TemplateAI.ReadConfig.
        if (_opTypeOverride >= 0)
        {
            Marshal.WriteInt32(new IntPtr(h.ToInt64() + RvaTemplateOpType), _opTypeOverride);
            Marshal.WriteByte(new IntPtr(h.ToInt64() + RvaTemplateUseTemplate),
                (byte)(_opTypeOverride != 0 ? 1 : 0));
        }
        if (_opDropCountOverride != int.MinValue)
        {
            Marshal.WriteInt32(new IntPtr(h.ToInt64() + RvaTemplateOpDropCount), _opDropCountOverride);
            Marshal.WriteInt32(new IntPtr(h.ToInt64() + RvaTemplatePrevOpDropCount), _opDropCountOverride);
        }
        Log("[config] overrides: viewNext=" + Marshal.ReadInt32(new IntPtr(h.ToInt64() + RvaConfigViewNext))
            + " usePCstack=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaConfigUsePCstack))
            + " configS4W=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaConfigUseS4W))
            + " evalS4W=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaEvalUseS4W))
            + " useTDOpeners=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaConfigUseTDOpeners))
            + " loopTemplate=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaConfigLoopTemplate)));
    }

    private static void InvokeTemplateReadConfig()
    {
        MethodInfo mi = Resolve(TokenTemplateReadConfig, "TemplateAI.ReadConfig", 0);
        if (mi != null) Invoke(mi);
    }

    // Observability for the TemplateAI state machine (SPEC_Search §9): pointers and
    // phase counters around a search, so a single oracle run can be tied to the
    // replica's state without a full game replay.
    private static void DumpTemplateStatics(string tag)
    {
        IntPtr h = ModuleBase();
        Log("[tmpl " + tag + "] babyNode=0x" + Marshal.ReadIntPtr(new IntPtr(h.ToInt64() + RvaExpandBabyNode)).ToInt64().ToString("x")
            + " expandedBaby=0x" + Marshal.ReadIntPtr(new IntPtr(h.ToInt64() + RvaExpandExpandedBaby)).ToInt64().ToString("x")
            + " expandedChild=0x" + Marshal.ReadIntPtr(new IntPtr(h.ToInt64() + RvaExpandExpandedChild)).ToInt64().ToString("x")
            + " tree=0x" + Marshal.ReadIntPtr(new IntPtr(h.ToInt64() + RvaSearchTree)).ToInt64().ToString("x"));
        Log("[tmpl " + tag + "] useTDOpeners=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaTemplateUseTDOpeners))
            + " useTemplate=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaTemplateUseTemplate))
            + " opType=" + Marshal.ReadInt32(new IntPtr(h.ToInt64() + RvaTemplateOpType))
            + " opDropCount=" + Marshal.ReadInt32(new IntPtr(h.ToInt64() + RvaTemplateOpDropCount))
            + " prevOpDropCount=" + Marshal.ReadInt32(new IntPtr(h.ToInt64() + RvaTemplatePrevOpDropCount))
            + " failTDOpeners=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaTemplateFailTDOpeners))
            + " useDPC=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaTemplateUseDPC))
            + " loopTemplate=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaTemplateLoopTemplate)));
    }

    private const int RvaWeightList = 0x66368;
    private const int RvaWeight = 0x66378;
    private const int EvalWeightSize = 272;

    private static void ApplyWeightIndex()
    {
        IntPtr h = ModuleBase();
        IntPtr list = Marshal.ReadIntPtr(new IntPtr(h.ToInt64() + RvaWeightList));
        IntPtr ptr = new IntPtr(list.ToInt64() + (long)_weightIndex * EvalWeightSize);
        Marshal.WriteIntPtr(new IntPtr(h.ToInt64() + RvaWeight), ptr);
        Log("[weight] in index=" + _weightIndex + " list=0x" + list.ToInt64().ToString("x")
            + " weight=0x" + ptr.ToInt64().ToString("x"));
    }

    private static void ReadWeightIndex()
    {
        IntPtr h = ModuleBase();
        IntPtr list = Marshal.ReadIntPtr(new IntPtr(h.ToInt64() + RvaWeightList));
        IntPtr ptr = Marshal.ReadIntPtr(new IntPtr(h.ToInt64() + RvaWeight));
        _outWeightIndex = (int)((ptr.ToInt64() - list.ToInt64()) / EvalWeightSize);
        Log("  weightIndex=" + _outWeightIndex);
    }

    private static int FrameOf(int nowMs)
    {
        return (int)(nowMs * 0.06);
    }

    private static IntPtr ModuleBase()
    {
        return Marshal.GetHINSTANCE(_asm.ManifestModule);
    }

    // Raw write of the carried OffsetOffAI statics (native memory; managed
    // reflection only sees the opaque `alignment member`). Offsets from
    // SPEC_OffsetOffAI.md: ofsData{canWait@0,c4@4,atk@8,pc@12,near@13},
    // gbData{atk@0,cool@4,rem@8,lockCount@12,firstInvalid@16}.
    private static void ApplyOffsetStatics()
    {
        IntPtr h = ModuleBase();
        Marshal.WriteByte(new IntPtr(h.ToInt64() + RvaUseOffsetOff), (byte)(_useOffsetOff != 0 ? 1 : 0));
        IntPtr ofs = new IntPtr(h.ToInt64() + RvaOfsData);
        Marshal.WriteByte(ofs, (byte)(_ofsCanWait != 0 ? 1 : 0));
        Marshal.WriteInt32(new IntPtr(ofs.ToInt64() + 4), _ofsCenter4);
        Marshal.WriteInt32(new IntPtr(ofs.ToInt64() + 8), _ofsAtk);
        Marshal.WriteByte(new IntPtr(ofs.ToInt64() + 12), (byte)(_ofsPcChance != 0 ? 1 : 0));
        Marshal.WriteByte(new IntPtr(ofs.ToInt64() + 13), (byte)(_ofsNearOffset != 0 ? 1 : 0));
        IntPtr gb = new IntPtr(h.ToInt64() + RvaGbData);
        Marshal.WriteInt32(gb, _gbOpponentsAtk);
        Marshal.WriteInt32(new IntPtr(gb.ToInt64() + 4), _gbCoolTime);
        Marshal.WriteInt32(new IntPtr(gb.ToInt64() + 8), _gbRemainingTime);
        Marshal.WriteInt32(new IntPtr(gb.ToInt64() + 12), _gbOpponentsLockCount);
        Marshal.WriteByte(new IntPtr(gb.ToInt64() + 16), (byte)(_gbFirstInvalidLock != 0 ? 1 : 0));
    }

    private static void ReadOffsetStatics()
    {
        IntPtr h = ModuleBase();
        _outUseOffsetOff = Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaUseOffsetOff));
        IntPtr ofs = new IntPtr(h.ToInt64() + RvaOfsData);
        _outOfsCanWait = Marshal.ReadByte(ofs);
        _outOfsCenter4 = Marshal.ReadInt32(new IntPtr(ofs.ToInt64() + 4));
        _outOfsAtk = Marshal.ReadInt32(new IntPtr(ofs.ToInt64() + 8));
        _outOfsPcChance = Marshal.ReadByte(new IntPtr(ofs.ToInt64() + 12));
        _outOfsNearOffset = Marshal.ReadByte(new IntPtr(ofs.ToInt64() + 13));
        IntPtr gb = new IntPtr(h.ToInt64() + RvaGbData);
        _outGbOpponentsAtk = Marshal.ReadInt32(gb);
        _outGbCoolTime = Marshal.ReadInt32(new IntPtr(gb.ToInt64() + 4));
        _outGbRemainingTime = Marshal.ReadInt32(new IntPtr(gb.ToInt64() + 8));
        _outGbOpponentsLockCount = Marshal.ReadInt32(new IntPtr(gb.ToInt64() + 12));
        _outGbFirstInvalidLock = Marshal.ReadByte(new IntPtr(gb.ToInt64() + 16));
    }

    private static void ResolveOffsetMethods()
    {
        if (_offsetMethodsResolved) return;
        _offsetMethodsResolved = true;
        _miUseOff = Resolve(0x060001d5, "OffsetOffAI.UseOffsetOff", 1);
        _miCanOff = Resolve(0x060001d7, "OffsetOffAI.CanOffsetOff", 1);
        _miDecOff = Resolve(0x060001d8, "OffsetOffAI.DecisionOffsetOff", 1);
        _miResetAtk = Resolve(0x060001d9, "OffsetOffAI.ResetOpponentsAtk", 0);
        _miCalcAtk = Resolve(0x060001da, "OffsetOffAI.CalcOpponentsAtk", 4);
        _miGetAtk = Resolve(0x060001db, "OffsetOffAI.GetOpponentsAtk", 0);
        _miSetPrev = Resolve(0x060001dc, "OffsetOffAI.SetPrevAct", 1);
        _miLockOff = Resolve(0x060001dd, "OffsetOffAI.LockOffsetAfterClearing", 3);
        _miOppNew = Resolve(0x060001de, "OffsetOffAI.OpponentIsNewLockDown", 1);
        _miInvAtk = Resolve(0x060001df, "OffsetOffAI.InvalidateGettingEnemysAtk", 0);
        _miIsLocked = Resolve(0x060001e0, "OffsetOffAI.IsLocked", 1);
        _miFirstInvalid = Resolve(0x060001e1, "OffsetOffAI.IsFirstInvalidLockDown", 0);
        if (_miUseOff == null || _miCanOff == null || _miDecOff == null || _miIsLocked == null)
            throw new InvalidOperationException("OffsetOffAI methods missing");
    }

    private static bool CallBool(MethodInfo mi, params object[] args)
    {
        return Convert.ToBoolean(Invoke(mi, args), CultureInfo.InvariantCulture);
    }

    // Mirror of rust/hoiko-core/src/offset_driver.rs::sync with the binary primitives.
    private static void SyncOffsetDriver()
    {
        int frame = FrameOf(_nowMs);
        if (_hasLastOwn != 0 && _syncLockId < _lastOwnId)
        {
            Invoke(_miUseOff, _offsetEnabled != 0);
            _hasLastOwn = 0;
            _hasLastOpp = 0;
        }
        if (_hasLastOwn != 0 && _syncLockId != _lastOwnId)
        {
            Invoke(_miSetPrev, _syncLastAction);
            Invoke(_miLockOff, frame, _syncLastAttack, _syncHasOppLock != 0 ? _syncOppLockId : 0);
        }
        _hasLastOwn = 1;
        _lastOwnId = _syncLockId;
        if (_syncHasOppLock != 0 && (_hasLastOpp == 0 || _syncOppLockId != _lastOppId))
        {
            if (CallBool(_miOppNew, _syncOppLockId)) Invoke(_miResetAtk);
            if (_syncOppClearLines > 0 && CallInt(_miGetAtk) == 0)
            {
                if (!CallBool(_miFirstInvalid))
                {
                    if (!CallBool(_miIsLocked, frame))
                    {
                        Invoke(_miCalcAtk, _syncOppClearLines, _syncOppBtb > 0 ? 1 : 0,
                            _syncOppBtb > 1 ? 1 : 0, _syncOppCombo);
                    }
                }
                else
                {
                    Invoke(_miInvAtk);
                }
            }
            _hasLastOpp = 1;
            _lastOppId = _syncOppLockId;
        }
    }

    private static void ApplyOffsetInput()
    {
        ResolveOffsetMethods();
        if (_isEvenBoard >= 0) SetEvenBoard(_isEvenBoard != 0);
        ApplyOffsetStatics();
        if (_syncEnabled != 0) SyncOffsetDriver();
        ReadOffsetStatics();
        Log("[offset] in pendingGarbage=" + _pendingGarbage + " nowMs=" + _nowMs + " enabled=" + _offsetEnabled
            + " sync=" + _syncEnabled + " lockId=" + _syncLockId + " lastAction=" + _syncLastAction
            + " lastAttack=" + _syncLastAttack + " oppLock=" + _syncHasOppLock + "/" + _syncOppLockId
            + " oppClear=" + _syncOppClearLines + " oppBtb=" + _syncOppBtb + " oppCombo=" + _syncOppCombo);
        Log("  OFFSET pre use=" + _outUseOffsetOff + " canWait=" + _outOfsCanWait + " center4=" + _outOfsCenter4
            + " atk=" + _outOfsAtk + " pc=" + _outOfsPcChance + " near=" + _outOfsNearOffset
            + " gbAtk=" + _outGbOpponentsAtk + " gbCool=" + _outGbCoolTime + " gbRem=" + _outGbRemainingTime
            + " gbLock=" + _outGbOpponentsLockCount + " gbFirst=" + _outGbFirstInvalidLock);
    }

    private static void RunOffsetDecision(IntPtr root)
    {
        ResolveOffsetMethods();
        int frame = FrameOf(_nowMs);
        if (_isEvenBoard >= 0) SetEvenBoard(_isEvenBoard != 0);
        if (_offsetEnabled != 0) Invoke(_miDecOff, root);
        int locked = CallBool(_miIsLocked, frame) ? 1 : 0;
        int canWait = CallBool(_miCanOff, _pendingGarbage) ? 1 : 0;
        _garbageWait = _offsetEnabled != 0 && locked == 0 && canWait != 0 ? 1 : 0;
        ReadOffsetStatics();
        Log("");
        Log("=============== OFFSET RESULT ===============");
        Log("  garbageWait=" + _garbageWait + " locked=" + locked + " canWait=" + canWait
            + " pendingGarbage=" + _pendingGarbage + " frame=" + frame);
        Log("  OFFSET post use=" + _outUseOffsetOff + " canWait=" + _outOfsCanWait + " center4=" + _outOfsCenter4
            + " atk=" + _outOfsAtk + " pc=" + _outOfsPcChance + " near=" + _outOfsNearOffset
            + " gbAtk=" + _outGbOpponentsAtk + " gbCool=" + _outGbCoolTime + " gbRem=" + _outGbRemainingTime
            + " gbLock=" + _outGbOpponentsLockCount + " gbFirst=" + _outGbFirstInvalidLock
            + " hasOwn=" + _hasLastOwn + " ownId=" + _lastOwnId
            + " hasOpp=" + _hasLastOpp + " oppId=" + _lastOppId);
        Log("  planacts=" + Marshal.ReadInt32(root, 904) + "," + Marshal.ReadInt32(root, 908) + "," + Marshal.ReadInt32(root, 912));
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

    private static void RunTemplateProbe(IntPtr root)
    {
        MethodInfo miTdCmp = Resolve(0x06000234, "TemplateAI.TDOpenersCmp", 1);
        MethodInfo miOrigin = Resolve(0x06000235, "TemplateAI.OriginNextCmp", 1);
        MethodInfo miDecision = Resolve(0x06000236, "TemplateAI.DecisionTemplate", 1);
        MethodInfo miDecisionLoop = Resolve(0x06000237, "TemplateAI.DecisionLoopTemplate", 1);
        MethodInfo miSearchTd = Resolve(0x06000221, "TemplateAI.SearchTDOpeners", 1);
        MethodInfo miOpEvalFirst = Resolve(0x06000220, "TemplateAI.OpEvaluateFirst", 2);
        MethodInfo miOpEval = Resolve(0x0600021F, "TemplateAI.OpEvaluate", 3);
        IntPtr h = ModuleBase();
        IntPtr game = new IntPtr(root.ToInt64() + 120);
        IntPtr fsPtr = Marshal.AllocHGlobal(4);
        IntPtr scorePtr = Marshal.AllocHGlobal(4);

        if (_prevOpOverride != int.MinValue)
            Marshal.WriteInt32(new IntPtr(h.ToInt64() + RvaTemplatePrevOpDropCount), _prevOpOverride);

        Log("");
        Log("=============== TEMPLATE PROBE ===============");
        Log("[tmpl] state0 " + TemplateStaticsLine(h));
        if (miTdCmp != null)
            Log("[tmpl] TDOpenersCmp=" + Convert.ToInt32(Invoke(miTdCmp, game), CultureInfo.InvariantCulture)
                + " | " + TemplateStaticsLine(h));
        if (miOrigin != null)
            Log("[tmpl] OriginNextCmp=" + Convert.ToInt32(Invoke(miOrigin, game), CultureInfo.InvariantCulture)
                + " | " + TemplateStaticsLine(h));
        if (miDecision != null)
            Log("[tmpl] DecisionTemplate=" + Convert.ToInt32(Invoke(miDecision, game), CultureInfo.InvariantCulture)
                + " | " + TemplateStaticsLine(h));
        if (miDecisionLoop != null)
            Log("[tmpl] DecisionLoopTemplate=" + Convert.ToInt32(Invoke(miDecisionLoop, root), CultureInfo.InvariantCulture)
                + " | " + TemplateStaticsLine(h));
        if (miSearchTd != null)
            Log("[tmpl] SearchTDOpeners=" + Convert.ToInt32(Invoke(miSearchTd, game), CultureInfo.InvariantCulture)
                + " | " + TemplateStaticsLine(h));
        if (miOpEvalFirst != null)
        {
            Marshal.WriteInt32(fsPtr, 0);
            Invoke(miOpEvalFirst, game, fsPtr);
            Log("[tmpl] OpEvaluateFirst fs=" + Marshal.ReadInt32(fsPtr) + " | " + TemplateStaticsLine(h));
        }
        if (miOpEval != null)
        {
            Marshal.WriteInt32(fsPtr, 0);
            Marshal.WriteInt32(scorePtr, 0);
            Invoke(miOpEval, game, scorePtr, fsPtr);
            Log("[tmpl] OpEvaluate score=" + Marshal.ReadInt32(scorePtr)
                + " fs=" + Marshal.ReadInt32(fsPtr) + " | " + TemplateStaticsLine(h));
        }

        Log("[tmpl] input lock=(" + Marshal.ReadInt32(game, 64) + "," + Marshal.ReadInt32(game, 68)
            + "," + Marshal.ReadInt32(game, 72) + "," + Marshal.ReadInt32(game, 76) + ")"
            + " fall=(" + Marshal.ReadInt32(game, 32) + "," + Marshal.ReadInt32(game, 36)
            + "," + Marshal.ReadInt32(game, 40) + "," + Marshal.ReadInt32(game, 44) + ")"
            + " hold=" + Marshal.ReadInt32(game, 16)
            + " remains=" + Marshal.ReadInt32(root, 116)
            + " stack=" + Marshal.ReadInt32(game, 224)
            + " rows=" + BoardRowsOf(new IntPtr(root.ToInt64() + 120)));
        Marshal.FreeHGlobal(scorePtr);
        Marshal.FreeHGlobal(fsPtr);
    }

    private static string TemplateStaticsLine(IntPtr h)
    {
        return "useTemplate=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaTemplateUseTemplate))
            + " opType=" + Marshal.ReadInt32(new IntPtr(h.ToInt64() + RvaTemplateOpType))
            + " opDropCount=" + Marshal.ReadInt32(new IntPtr(h.ToInt64() + RvaTemplateOpDropCount))
            + " prev=" + Marshal.ReadInt32(new IntPtr(h.ToInt64() + RvaTemplatePrevOpDropCount))
            + " fail=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaTemplateFailTDOpeners))
            + " useDPC=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaTemplateUseDPC))
            + " loop=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaTemplateLoopTemplate));
    }

    private static void RunOpExpandProbe(IntPtr root)
    {
        MethodInfo miTemplate = Resolve(0x060001F8, "ExpandAI.ExpandTemplateNode", 2);
        MethodInfo miOpDerive = Resolve(0x060001FA, "ExpandAI.OpExpandDeriveNode", 4);
        MethodInfo miOpExpand = Resolve(0x060001F9, "ExpandAI.OpExpandNode", 3);
        MethodInfo miRegist = Resolve(0x060001ED, "ExpandAI.RegistChildNode", 4);
        MethodInfo miColHeight = Resolve(0x0600025C, "Board.GetColumnHeight", 2);
        IntPtr h = ModuleBase();
        IntPtr babyNode = Marshal.ReadIntPtr(new IntPtr(h.ToInt64() + RvaExpandBabyNode));
        IntPtr game = new IntPtr(root.ToInt64() + 120);
        IntPtr outBuf = Marshal.AllocHGlobal(NodeStride * NodeCap);
        IntPtr countPtr = Marshal.AllocHGlobal(4);
        IntPtr chPtr = Marshal.AllocHGlobal(40);
        byte[] scratch = new byte[136];

        Log("");
        Log("=============== OP EXPAND PROBE ===============");
        Log("[opexpand] babyNode=0x" + babyNode.ToInt64().ToString("x")
            + " useTDOpeners=" + Marshal.ReadByte(new IntPtr(h.ToInt64() + RvaTemplateUseTDOpeners))
            + " opType=" + Marshal.ReadInt32(new IntPtr(h.ToInt64() + RvaTemplateOpType))
            + " opDropCount=" + Marshal.ReadInt32(new IntPtr(h.ToInt64() + RvaTemplateOpDropCount)));
        if (babyNode == IntPtr.Zero) { Log("[opexpand] babyNode null"); return; }

        // Prepare slot 0 exactly like ExpandNode: fallingMino(32) @+0, hold(12) @+88,
        // nextIt(16) @+104, Command.Init @+32.
        Marshal.Copy(new IntPtr(game.ToInt64() + 32), scratch, 0, 32);
        Marshal.Copy(scratch, 0, babyNode, 32);
        Marshal.Copy(new IntPtr(game.ToInt64() + 16), scratch, 0, 12);
        Marshal.Copy(scratch, 0, new IntPtr(babyNode.ToInt64() + 88), 12);
        Marshal.Copy(game, scratch, 0, 16);
        Marshal.Copy(scratch, 0, new IntPtr(babyNode.ToInt64() + 104), 16);
        for (int i = 0; i < 56; i += 4) Marshal.WriteInt32(new IntPtr(babyNode.ToInt64() + 32 + i), 0);

        int count = Convert.ToInt32(Invoke(miTemplate, babyNode, 1), CultureInfo.InvariantCulture);
        Log("[opexpand] ExpandTemplateNode -> count=" + count + " (m=" + Marshal.ReadInt32(game, 44) + ")");
        DumpBabyArena(babyNode, Math.Min(count, 40));

        for (int c = 0; c < 10; c++) Marshal.WriteInt32(chPtr, c * 4, -1);
        Invoke(miColHeight, new IntPtr(game.ToInt64() + 96), chPtr);
        count = Convert.ToInt32(Invoke(miOpDerive, babyNode, count,
            new IntPtr(game.ToInt64() + 96), chPtr), CultureInfo.InvariantCulture);
        Log("[opexpand] OpExpandDeriveNode -> count=" + count);
        DumpBabyArena(babyNode, Math.Min(count, 60));

        try
        {
            Marshal.WriteInt32(countPtr, 0);
            Invoke(miOpExpand, game, outBuf, countPtr);
            Log("[opexpand] OpExpandNode -> count=" + Marshal.ReadInt32(countPtr));
        }
        catch (Exception e) { Log("[opexpand] OpExpandNode threw: " + Describe(e)); }

        if (miRegist != null)
        {
            try
            {
                int rc = Convert.ToInt32(Invoke(miRegist, babyNode, count, game, outBuf), CultureInfo.InvariantCulture);
                Log("[opexpand] RegistChildNode -> count=" + rc);
            }
            catch (Exception e) { Log("[opexpand] RegistChildNode threw: " + Describe(e)); }
        }

        if (_opExpandProbe >= 2)
        {
            // Replicate the OpSearch generation loop: expand every gen-1 child and
            // report which parent (if any) breaks the arena/dedup.
            IntPtr out2 = Marshal.AllocHGlobal(NodeStride * NodeCap);
            Marshal.WriteInt32(countPtr, 0);
            Invoke(miOpExpand, game, outBuf, countPtr);
            int c1 = Marshal.ReadInt32(countPtr);
            if (c1 < 0) c1 = 0;
            if (c1 > NodeCap) c1 = NodeCap;
            Log("[opexpand] gen1 count=" + c1);
            for (int i = 0; i < c1; i++)
            {
                IntPtr parent = new IntPtr(outBuf.ToInt64() + i * NodeStride);
                try
                {
                    Marshal.WriteInt32(countPtr, 0);
                    Invoke(miOpExpand, parent, out2, countPtr);
                    Log("[opexpand] gen2[" + i + "] count=" + Marshal.ReadInt32(countPtr)
                        + " fallM=" + Marshal.ReadInt32(parent, 44)
                        + " lockM=" + Marshal.ReadInt32(parent, 76)
                        + " lockX=" + Marshal.ReadInt32(parent, 64)
                        + " lockY=" + Marshal.ReadInt32(parent, 68)
                        + " lockR=" + Marshal.ReadInt32(parent, 72)
                        + " stack=" + Marshal.ReadInt32(parent, 224)
                        + " lb=" + Marshal.ReadInt32(parent, 228));
                }
                catch (Exception e)
                {
                    Log("[opexpand] gen2[" + i + "] THREW: " + Describe(e));
                    IntPtr ec2 = Marshal.ReadIntPtr(new IntPtr(h.ToInt64() + RvaExpandExpandedChild));
                    StringBuilder bs = new StringBuilder("[opexpand] child buckets after throw: ec=0x"
                        + ec2.ToInt64().ToString("x") + " ");
                    for (int k = 0; k < 40; k++)
                    {
                        int cnt = Marshal.ReadInt32(new IntPtr(ec2.ToInt64() + k * 168));
                        if (cnt == 0) continue;
                        long p0 = Marshal.ReadInt64(new IntPtr(ec2.ToInt64() + k * 168 + 8));
                        bs.Append(k).Append(":c=").Append(cnt).Append(":p0=0x").Append(p0.ToString("x")).Append(' ');
                    }
                    Log(bs.ToString());
                    Log("[opexpand] parent fallM=" + Marshal.ReadInt32(parent, 44)
                        + " lockM=" + Marshal.ReadInt32(parent, 76)
                        + " lockX=" + Marshal.ReadInt32(parent, 64)
                        + " lockY=" + Marshal.ReadInt32(parent, 68)
                        + " lockR=" + Marshal.ReadInt32(parent, 72)
                        + " stack=" + Marshal.ReadInt32(parent, 224)
                        + " lb=" + Marshal.ReadInt32(parent, 228));
                    break;
                }
            }
            Marshal.FreeHGlobal(out2);
        }

        if (_opExpandProbe >= 4)
        {
            IntPtr out2 = Marshal.AllocHGlobal(NodeStride * NodeCap);
            Invoke(miOpExpand, game, outBuf, countPtr);
            int c1 = Marshal.ReadInt32(countPtr);
            if (c1 < 0) c1 = 0;
            if (c1 > NodeCap) c1 = NodeCap;
            IntPtr ec = Marshal.ReadIntPtr(new IntPtr(h.ToInt64() + RvaExpandExpandedChild));
            for (int i = 0; i < c1; i++)
            {
                IntPtr parent = new IntPtr(outBuf.ToInt64() + i * NodeStride);
                try
                {
                    Marshal.WriteInt32(countPtr, 0);
                    Invoke(miOpExpand, parent, out2, countPtr);
                }
                catch (Exception e)
                {
                    Log("[buckets] parent " + i + " threw: " + e.Message);
                    continue;
                }
                StringBuilder sb = new StringBuilder("[buckets] parent " + i + " counts=");
                for (int k = 0; k < 40; k++)
                {
                    int cnt = Marshal.ReadInt32(new IntPtr(ec.ToInt64() + k * 168));
                    if (cnt > 0) sb.Append(k).Append(':').Append(cnt).Append(' ');
                }
                Log(sb.ToString());
            }
            Marshal.FreeHGlobal(out2);
        }

        if (_opExpandProbe >= 3)
        {
            const int Big = 4096;
            IntPtr gen2 = Marshal.AllocHGlobal(NodeStride * Big);
            IntPtr gen3 = Marshal.AllocHGlobal(NodeStride * Big);
            int c1 = 0;
            {
                Marshal.WriteInt32(countPtr, 0);
                Invoke(miOpExpand, game, outBuf, countPtr);
                c1 = Marshal.ReadInt32(countPtr);
                if (c1 < 0) c1 = 0;
                if (c1 > NodeCap) c1 = NodeCap;
            }
            int g2 = 0;
            for (int i = 0; i < c1; i++)
            {
                IntPtr parent = new IntPtr(outBuf.ToInt64() + i * NodeStride);
                Marshal.WriteInt32(countPtr, 0);
                Invoke(miOpExpand, parent, new IntPtr(gen2.ToInt64() + (long)g2 * NodeStride), countPtr);
                int n = Marshal.ReadInt32(countPtr);
                if (n < 0) n = 0;
                if (g2 + n > Big) n = Big - g2;
                g2 += n;
            }
            Log("[opexpand] gen2 total=" + g2);
            {
                IntPtr mod0 = ModuleBase();
                Log("[opexpand] statics before gen3: expandedChild=0x"
                    + Marshal.ReadIntPtr(new IntPtr(mod0.ToInt64() + RvaExpandExpandedChild)).ToInt64().ToString("x"));
            }
            for (int j = 0; j < g2; j++)
            {
                IntPtr parent = new IntPtr(gen2.ToInt64() + j * NodeStride);
                try
                {
                    Marshal.WriteInt32(countPtr, 0);
                    Invoke(miOpExpand, parent, gen3, countPtr);
                }
                catch (Exception e)
                {
                    IntPtr mod = ModuleBase();
                    Log("[opexpand] gen3[" + j + "/" + g2 + "] THREW: " + Describe(e));
                    Log("[opexpand] statics after throw: expandedChild=0x"
                        + Marshal.ReadIntPtr(new IntPtr(mod.ToInt64() + RvaExpandExpandedChild)).ToInt64().ToString("x")
                        + " expandedBaby=0x"
                        + Marshal.ReadIntPtr(new IntPtr(mod.ToInt64() + RvaExpandExpandedBaby)).ToInt64().ToString("x")
                        + " babyNode=0x"
                        + Marshal.ReadIntPtr(new IntPtr(mod.ToInt64() + RvaExpandBabyNode)).ToInt64().ToString("x"));
                    Log("[opexpand] parent lock=(" + Marshal.ReadInt32(parent, 64) + ","
                        + Marshal.ReadInt32(parent, 68) + "," + Marshal.ReadInt32(parent, 72) + ","
                        + Marshal.ReadInt32(parent, 76) + ")"
                        + " fall=(" + Marshal.ReadInt32(parent, 32) + ","
                        + Marshal.ReadInt32(parent, 36) + "," + Marshal.ReadInt32(parent, 40) + ","
                        + Marshal.ReadInt32(parent, 44) + ")"
                        + " stack=" + Marshal.ReadInt32(parent, 224)
                        + " lb=" + Marshal.ReadInt32(parent, 228)
                        + " act=" + Marshal.ReadInt32(parent, 296)
                        + " combo=" + Marshal.ReadInt32(parent, 288)
                        + " btb=" + Marshal.ReadInt32(parent, 292)
                        + " delay=" + Marshal.ReadInt32(parent, 280));
                    Log("[opexpand] parent rows=" + BoardRowsOf(parent));
                    break;
                }
            }
            Marshal.FreeHGlobal(gen3);
            Marshal.FreeHGlobal(gen2);
        }

        Marshal.FreeHGlobal(chPtr);
        Marshal.FreeHGlobal(countPtr);
        Marshal.FreeHGlobal(outBuf);
    }

    private static string BoardRowsOf(IntPtr node)
    {
        StringBuilder sb = new StringBuilder();
        for (int r = 0; r < 32; r++)
        {
            if (r > 0) sb.Append(',');
            sb.Append(Marshal.ReadInt32(node, 96 + r * 4));
        }
        return sb.ToString();
    }

    private static void DumpBabyArena(IntPtr babyNode, int n)
    {
        for (int i = 0; i < n; i++)
        {
            IntPtr b = new IntPtr(babyNode.ToInt64() + i * 120);
            Log("BABY " + i
                + " x=" + Marshal.ReadInt32(b, 0)
                + " y=" + Marshal.ReadInt32(b, 4)
                + " r=" + Marshal.ReadInt32(b, 8)
                + " m=" + Marshal.ReadInt32(b, 12)
                + " lastSrs=" + Marshal.ReadInt32(b, 16)
                + " bugG=" + Marshal.ReadInt32(b, 20)
                + " delay=" + Marshal.ReadInt32(b, 80)
                + " len=" + Marshal.ReadInt32(b, 84)
                + " hold=" + Marshal.ReadInt32(b, 88)
                + " swapped=" + Marshal.ReadInt32(b, 92)
                + " nextM=0x" + Marshal.ReadIntPtr(b, 104).ToInt64().ToString("x")
                + " fit=" + Marshal.ReadIntPtr(b, 112).ToInt64().ToString("x"));
        }
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

    private static void DumpTree()
    {
        const int TreeFieldRva = 0x663D8;
        const int ArenaBytes = 56580000;
        IntPtr hinst = Marshal.GetHINSTANCE(_asm.ManifestModule);
        IntPtr slot = new IntPtr(hinst.ToInt64() + TreeFieldRva);
        IntPtr tree = Marshal.ReadIntPtr(slot);
        Log("[tree] hinst=0x" + hinst.ToInt64().ToString("x") + " tree=0x" + tree.ToInt64().ToString("x"));
        if (tree == IntPtr.Zero) return;
        byte[] data = new byte[ArenaBytes];
        Marshal.Copy(tree, data, 0, ArenaBytes);
        string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "oracle_tree.bin");
        File.WriteAllBytes(path, data);
        Log("[tree] wrote " + path + " (" + data.Length + " bytes)");
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
