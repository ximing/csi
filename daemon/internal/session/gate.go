package session

import (
	"context"
	"sync"
)

// fifo 按等待者入队顺序传递锁（协议 §3.4：同 session FIFO）。
// sync.Mutex 不保证唤醒顺序，不能用来满足「响应完成顺序不能反转 currentTarget」。
type fifo struct {
	mu   sync.Mutex
	held bool
	wait []chan struct{}
}

func (f *fifo) Lock() {
	_ = f.LockCtx(context.Background())
}

// LockCtx 同 Lock，但排队期间响应 ctx 取消：取消的等待者把自己从 FIFO 队列摘除，
// 返回 ctx.Err()，不再占用 gate。
// 若取消与授权同时发生（Unlock 已把本等待者出队并 close(ch)），授权优先、返回 nil，
// 调用方必须把这次授权用掉或放掉——授权 channel 既不泄漏也不重复。
func (f *fifo) LockCtx(ctx context.Context) error {
	f.mu.Lock()
	if !f.held {
		f.held = true
		f.mu.Unlock()
		return nil
	}
	ch := make(chan struct{})
	f.wait = append(f.wait, ch)
	f.mu.Unlock()

	select {
	case <-ch:
		return nil
	case <-ctx.Done():
	}

	// 与 Unlock 的出队/close 在 f.mu 下串行：ch 还在队列则摘除，授权随之作废；
	// 不在队列说明 Unlock 已发出授权，必须收下（ch 已 close，<-ch 立即返回）。
	f.mu.Lock()
	for i, c := range f.wait {
		if c == ch {
			f.wait = append(f.wait[:i], f.wait[i+1:]...)
			f.mu.Unlock()
			return ctx.Err()
		}
	}
	f.mu.Unlock()
	<-ch
	return nil
}

func (f *fifo) Unlock() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.wait) > 0 {
		ch := f.wait[0]
		f.wait = f.wait[1:]
		close(ch)
		return
	}
	f.held = false
}
