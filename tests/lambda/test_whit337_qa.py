"""WHIT-337 QA gaps (adversarial) — the ANZ pending-column geometry MOVED from
lambda/repository.py._pending_merchant_column to lambda/merchant.py, exposed as
public pending_merchant_column / is_anz_pending. Intended ZERO behaviour change.
These pin the gaps the implementer's tests + the repointed suites don't: the two
public functions' cross-contract, and the clean_merchant-vs-positional divergence that
is the reason both now live in one module. (The slice's own edges + move-equivalence
table live in test_merchant.py beside the code; is_anz_pending's bool contract is pinned
by test_merchant.py::test_is_anz_pending. Neither is repeated here.)"""


# --- [G2a] public cross-contract between the two now-public functions ------------------
def test_a_readable_column_implies_anz_pending(lam):
    # If a column can be sliced, the row MUST be recognised as ANZ-shaped. The inverse is
    # deliberately NOT true (a blank-column ANZ row is still ANZ), which is why the two
    # functions exist separately -- pin the one-directional implication.
    col = lam.merchant.pending_merchant_column
    anz = lam.merchant.is_anz_pending
    descriptions = [
        "POS AUTHORISATION         SQ *KKV INTERNATIONAL PTYSunshine     AU",
        "POS AUTHORISATION         COLES 0602               MELBOURNE    AU",
        "POS AUTHORISATION  C",
        "POS AUTHORISATION         " + " " * 25 + "MELBOURNE    AU",   # ANZ but blank -> None
        "COLES 0602 MELBOURNE",                                        # not ANZ -> None
    ]
    for description in descriptions:
        if col(description) is not None:
            assert anz(description) is True, description


# --- [G3] clean_merchant (whitespace) vs pending_merchant_column (position) divergence --
def test_positional_read_diverges_from_clean_merchant_on_the_fused_column(lam):
    # Both read "the merchant column" and now live in one module, by DIFFERENT mechanisms.
    # On the fused live row they MUST disagree: clean_merchant fuses the suburb on, the
    # positional slice cuts it off. Pin it so a "unify them" refactor reds here.
    fused = "POS AUTHORISATION" + " " * 9 + "SQ *KKV INTERNATIONAL PTYSunshine     AU"
    clean = lam.merchant.clean_merchant(fused)
    column = lam.merchant.pending_merchant_column(fused)
    assert column == "SQ *KKV INTERNATIONAL PTY"
    assert "Sunshine" not in column                       # position kept the suburb out
    assert "Sunshine" in clean                             # whitespace split let it fuse
    assert clean != column


def test_positional_and_clean_agree_on_a_normally_spaced_column(lam):
    # Where the merchant does NOT fill the column, the two agree (after clean's strip) --
    # the guard that the divergence above is the fused-only pathology, not a blanket miss.
    spaced = "POS AUTHORISATION" + " " * 9 + "COLES 0602".ljust(25) + "MELBOURNE    AU"
    assert lam.merchant.pending_merchant_column(spaced).strip() == "COLES 0602"
    assert lam.merchant.clean_merchant(spaced) == "COLES"   # clean also strips the store num


# --- [G4] the 25-vs-26 docstring safety claim, pinned against a constructed 26-char name -
def test_pending_column_cuts_a_26_char_name_short_of_the_posted_field(lam):
    # Corrected docstring: pending column = 25 wide, posted merchantName = 26. A 26-char
    # merchant is cut at a DIFFERENT point on the two sides and can never match -- the safe
    # direction. Pin: pending slice is exactly 25 chars and != the 26-char name.
    name26 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"                  # exactly 26 chars
    assert len(name26) == 26
    pend = "POS AUTHORISATION" + " " * 9 + name26 + "SUBURB"
    column = lam.merchant.pending_merchant_column(pend)
    assert len(column) == 25                               # the pending column width
    assert column == name26[:25]                           # cut short of the last char
    assert column != name26                                # cannot equal a 26-wide posted field
