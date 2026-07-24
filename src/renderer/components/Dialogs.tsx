/** Restore and recovery confirmation dialogs (FR-7, FR-8). */
import React from 'react';
import { useAppStore } from '../state/appStore';
import { Button, Modal } from './ui';

export function RestoreDialog(): React.JSX.Element | null {
  const dialog = useAppStore((state) => state.restoreDialog);
  const close = useAppStore((state) => state.closeRestoreDialog);
  const confirm = useAppStore((state) => state.confirmRestore);
  const file = useAppStore((state) => state.selectedFile);

  if (!dialog) return null;
  const outcome = dialog.outcome;

  if (outcome && outcome.status === 'restored') {
    return (
      <Modal title="Version restored" onClose={close} footer={<Button variant="primary" onClick={close}>Done</Button>}>
        <p>
          <code>{outcome.path}</code> now contains the selected version, byte for byte. A new
          “Restored” entry was added to its history; every earlier and later version is still there.
        </p>
      </Modal>
    );
  }

  if (outcome && outcome.status === 'noop') {
    return (
      <Modal title="Nothing to restore" onClose={close} footer={<Button variant="primary" onClick={close}>Close</Button>}>
        <p>The file on disk is already identical to this version, so no change is needed.</p>
      </Modal>
    );
  }

  if (outcome && outcome.status === 'failed') {
    return (
      <Modal title="Restore failed" onClose={close} footer={<Button onClick={close}>Close</Button>}>
        <p>{outcome.reason}</p>
        <p className="mt-2 text-muted">Your file was not modified.</p>
      </Modal>
    );
  }

  return (
    <Modal
      title={dialog.conflict ? 'The file changed since you opened this' : 'Restore this version?'}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={dialog.busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void confirm(dialog.conflict)} disabled={dialog.busy}>
            {dialog.busy ? 'Restoring…' : dialog.conflict ? 'Overwrite anyway' : 'Restore'}
          </Button>
        </>
      }
    >
      {dialog.conflict ? (
        <>
          <p>
            <code>{file?.currentPath}</code> was modified after this dialog opened, so Recover.MD did
            not overwrite it.
          </p>
          <p className="mt-2">
            The current content has been recorded in the timeline first, so continuing is still
            reversible. Confirm again to replace what is on disk now.
          </p>
        </>
      ) : (
        <>
          <p>
            This replaces <code>{file?.currentPath}</code> with the exact bytes of the selected
            version.
          </p>
          <ul className="mt-2 list-disc pl-5 text-muted">
            <li>The current content is recorded first, so you can undo this.</li>
            <li>Newer versions stay in the timeline.</li>
            <li>Nothing outside this file is touched.</li>
          </ul>
        </>
      )}
    </Modal>
  );
}

export function RecoverDialog(): React.JSX.Element | null {
  const dialog = useAppStore((state) => state.recoverDialog);
  const close = useAppStore((state) => state.closeRecoverDialog);
  const confirm = useAppStore((state) => state.confirmRecover);

  if (!dialog) return null;
  const outcome = dialog.outcome;

  if (outcome && outcome.status === 'recovered') {
    return (
      <Modal title="File recovered" onClose={close} footer={<Button variant="primary" onClick={close}>Done</Button>}>
        <p>
          Recovered to <code>{outcome.path}</code>.
        </p>
      </Modal>
    );
  }

  if (outcome && outcome.status === 'path_occupied') {
    return (
      <Modal
        title="Something is already at that path"
        onClose={close}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button onClick={() => void confirm('rename')}>
              Recover as {outcome.suggestedPath.split('/').pop()}
            </Button>
            <Button variant="danger" onClick={() => void confirm('replace')}>
              Replace the existing file
            </Button>
          </>
        }
      >
        <p>
          <code>{outcome.path}</code> exists on disk. Recover.MD will not overwrite it unless you ask
          it to. Replacing records the current file first, so that is reversible too.
        </p>
      </Modal>
    );
  }

  if (outcome && outcome.status === 'missing_parent') {
    return (
      <Modal
        title="The original folder no longer exists"
        onClose={close}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void confirm('fail')}>
              Re-create the folder and recover
            </Button>
          </>
        }
      >
        <p>
          <code>{outcome.path}</code> is inside a folder that has been removed.
        </p>
      </Modal>
    );
  }

  if (outcome && outcome.status === 'failed') {
    return (
      <Modal title="Recovery failed" onClose={close} footer={<Button onClick={close}>Close</Button>}>
        <p>{outcome.reason}</p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Recover this file?"
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={dialog.busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void confirm('fail')} disabled={dialog.busy}>
            {dialog.busy ? 'Recovering…' : 'Recover file'}
          </Button>
        </>
      }
    >
      <p>
        This writes the selected version back to <code>{dialog.path}</code>. If something already
        occupies that path, you will be asked what to do.
      </p>
    </Modal>
  );
}
